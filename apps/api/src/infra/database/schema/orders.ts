import type { OrderActorKind, OrderStatus } from '@tezusta/types';
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { addresses } from './addresses';
import { adminUsers } from './admin';
import { customers } from './customers';
import { masters } from './masters';
import { services } from './services';
import { users } from './users';

/**
 * The fourteen states an order can be in, fixed by
 * [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md).
 *
 * A Postgres enum rather than a text column with a CHECK, because the set is
 * closed and the database should refuse a typo rather than store it
 * (`docs/architecture/database-architecture.md` § Conventions). The cost is
 * that adding a status is a migration — which is the correct cost, since
 * adding one is also a new ADR.
 *
 * The **edges** between these values are not here. They live in exactly one
 * place, `apps/api/src/modules/orders/order-lifecycle.ts`, because a set of
 * legal pairs is not something a column type can express and splitting the
 * rule across two mechanisms would mean two places to disagree.
 */
export const orderStatus = pgEnum('order_status', [
  'DRAFT',
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
  'NO_MASTER_FOUND',
  'CANCELLED',
]);

/**
 * One request for work.
 *
 * The row is created as `DRAFT` and moved to `SEARCHING` inside the same
 * transaction (ADR-0015). That intermediate state is what makes creation
 * idempotent — the idempotency key is written with the draft, so a retry
 * collides with a row that already exists rather than racing to insert a
 * second one.
 *
 * **`price_minor` and `master_id` are one fact in two columns.** They are
 * written together in the accept transaction and cleared together on
 * re-dispatch ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)), and
 * the CHECK below is what stops them drifting apart — a price with no master
 * would be a number the platform could not explain the origin of.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),

    /**
     * The **customer profile**, not the user account. One human may hold both
     * roles, and an order belongs to them as a customer — the same distinction
     * `addresses` draws.
     */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    /**
     * Where the work is. `onDelete: 'restrict'` here is doing real work: a
     * customer deleting a saved address must not be able to erase where a
     * completed job happened, so the address is soft-deleted and this
     * reference keeps pointing at it.
     */
    addressId: uuid('address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),

    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),

    /**
     * Null until a master accepts, and null again after a re-dispatch. That
     * second null is what keeps the accept guard correct on the next round:
     * the conditional UPDATE matches on `master_id is null`, so an order that
     * kept a stale master could never be claimed again.
     */
    masterId: uuid('master_id').references(() => masters.id, { onDelete: 'restrict' }),

    /**
     * No default. An order is created as `DRAFT` by the one code path allowed
     * to create one, and a default would let a future insert somewhere else
     * silently pick a starting state.
     */
    status: orderStatus('status').notNull(),

    /**
     * What the customer says is wrong, in their own words.
     *
     * Untrusted free text, so it is bounded here as well as in the request
     * schema — Zod runs on the request path only, and this column is also
     * written by seeds, migrations and whatever admin tooling arrives later.
     * The lower bound is 1 rather than a product minimum: how much a customer
     * must type before the app will submit is a question for the request
     * schema (issue #81), not for the table.
     */
    description: text('description').notNull(),

    /**
     * Integer minor units — 15.00 AZN is `1500`
     * (`docs/architecture/database-architecture.md` § Conventions). `mode:
     * 'number'` matches `master_services.price_minor`, for the same reasons.
     *
     * **Nullable, deliberately.** It is null for the whole of `SEARCHING`, and
     * a `NOT NULL` constraint would be wrong (ADR-0013). So would a default of
     * zero: the price does not exist until a master accepts, and zero is a
     * price.
     */
    priceMinor: bigint('price_minor', { mode: 'number' }),

    /**
     * How many times this order has gone back out to `SEARCHING`. Capped by
     * `MAX_ORDER_REDISPATCHES` in configuration rather than by a constraint
     * here — the cap is a tuning parameter, and freezing it into the schema
     * would make changing it a migration.
     */
    redispatchCount: integer('redispatch_count').notNull().default(0),

    /**
     * How many problem photos are attached (issue #83). The same shape as
     * `redispatchCount` above: `MAX_ORDER_PHOTOS` is a tuning parameter kept
     * in configuration, not a CHECK here, and the number of live attachments
     * is claimed atomically — `order-photos.repository.ts` guards the
     * increment with `WHERE photo_count < :maxPhotos` in the same statement
     * that claims a slot, so two concurrent attaches cannot both believe they
     * got the last one.
     *
     * **This column obliges every future writer that removes a photo to
     * decrement it in the same statement.** Nothing today detaches or
     * deletes an attached photo, so nothing yet owes that debt — but the
     * moment a detach endpoint or an admin delete lands without also
     * decrementing this column, the count only ever grows, and an order's
     * cap silently tightens forever with no error to notice it by.
     */
    photoCount: integer('photo_count').notNull().default(0),

    /**
     * The client's own key for "this is the same request I already sent".
     *
     * Unique per customer, enforced by the index below. The alternative —
     * reading for an existing order and inserting if there is none — races
     * against precisely the duplicate retry it is meant to prevent, because
     * both requests read before either writes.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /** When a master claimed it. Written in the accept transaction, cleared on re-dispatch. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * **One customer cannot create the same order twice.**
     *
     * Scoped to the customer rather than global: two customers picking the
     * same key is a coincidence, not a duplicate, and a global unique index
     * would let one client's key collide with a stranger's — and, worse, let a
     * client probe whether a key was already in use.
     */
    uniqueIndex('orders_customer_idempotency_key_unique').on(
      table.customerId,
      table.idempotencyKey,
    ),

    /**
     * **A master holds at most one active order**
     * (`docs/architecture/database-architecture.md` § Integrity). In the
     * application this would be a read followed by a write, and two accepts
     * arriving together would both read "no active order". Here it is one
     * index that cannot be raced.
     *
     * `SEARCHING` is absent from the list because a searching order has no
     * master by definition; the terminal states are absent because a finished
     * order holds nobody.
     *
     * **The same four statuses are spelled again as
     * `MASTER_ENGAGED_ORDER_STATUSES`** in `modules/orders/orders.repository.ts`,
     * which is what makes "which active order is this master on" (#169) an
     * index lookup on this index rather than a scan. They cannot be one
     * declaration: a partial index's predicate has to be literal SQL that a
     * migration can diff. A test asserts the query plan, so a drift shows up
     * as a failure rather than as a slow hot path.
     */
    uniqueIndex('orders_one_active_per_master')
      .on(table.masterId)
      .where(
        sql`${table.status} in ('ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS')`,
      ),

    /**
     * **The target of `reviews_order_parties_fk`, and nothing else** (issue
     * #221, ADR-0042 § Integrity). `id` alone is already unique, so this
     * index constrains nothing new; it exists because a foreign key may only
     * reference a column set covered by a unique constraint, and a composite
     * key is what makes a review about any other pair of people
     * unrepresentable. A null `master_id` is fine here — a searching order
     * simply has no triple a review could match.
     */
    uniqueIndex('orders_id_parties_unique').on(table.id, table.customerId, table.masterId),

    /** The dispatch queue scan: everything still searching, oldest first. */
    index('orders_status_created_idx').on(table.status, table.createdAt),

    /**
     * The admin order list with no status filter, newest first (issue #245).
     * The per-customer and per-master indexes serve the apps; this one serves
     * the panel's unfiltered first page, which would otherwise sort the table.
     */
    index('orders_created_idx').on(sql`${table.createdAt} desc`, sql`${table.id} desc`),

    /**
     * The customer's own order history, newest first.
     *
     * **`id` is the third column, and it is what makes pagination O(page).**
     * `docs/architecture/database-architecture.md` lists this index as
     * `(customer_id, created_at DESC)`, which serves the *filter* but not the
     * *order*: the keyset cursor is `(created_at, id)`, so without `id` here
     * Postgres has to fetch every row older than the cursor and top-N sort it,
     * and the cost of page five grows with how long the customer has been a
     * customer. Measured on 200,000 orders it read 179 rows to return 21 —
     * harmless at that size and not harmless at ten times it (issue #82).
     *
     * **The descending columns are written as `sql`, and that is what makes
     * the property above true rather than merely intended** (issue #191).
     * Drizzle's `.desc()` emits `DESC NULLS LAST` in an index definition,
     * while a bare `ORDER BY created_at DESC` means `DESC NULLS FIRST`. The
     * planner compares the ordering *specifications*, not what the data can
     * contain, so `NOT NULL` columns do not rescue the mismatch: Postgres used
     * this index for the filter and then sorted every matching row anyway. On
     * a 5,000-row scratch table, Postgres 17, with the alternatives disabled:
     * `DESC NULLS LAST` gave an index-only scan plus a `Sort`, plain `DESC`
     * gave an index-only scan and no sort at all.
     *
     * The other fix — spelling `NULLS LAST` in every `ORDER BY` — was tried
     * first and reverted with #191. It makes the idiomatic query the wrong
     * one, so the next person to write `order by created_at desc` silently
     * loses the index again. Asserted by `test/ordered-indexes.schema.test.ts`,
     * because nothing else notices.
     */
    index('orders_customer_created_idx').on(
      table.customerId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),

    /**
     * The master's order history, newest first. No consumer yet — EPIC 8's job
     * list is where it gets one — so `id` is absent deliberately: the keyset
     * shape is the customer list's, not necessarily this one's, and a column
     * added on a guess is a column nothing measures.
     */
    index('orders_master_created_idx').on(table.masterId, sql`${table.createdAt} desc`),

    /**
     * The two remaining foreign keys. Postgres does not index a foreign key on
     * its own, and without these a write to `addresses` or `services` has to
     * scan this whole table to check the reference.
     */
    index('orders_address_idx').on(table.addressId),
    index('orders_service_idx').on(table.serviceId),

    check('orders_description_length', sql`length(btrim(${table.description})) between 1 and 2000`),

    check(
      'orders_idempotency_key_length',
      sql`length(btrim(${table.idempotencyKey})) between 1 and 128`,
    ),

    /** A free repair is a product decision nobody has made. Same rule as `master_services`. */
    check('orders_price_positive', sql`${table.priceMinor} is null or ${table.priceMinor} > 0`),

    check('orders_redispatch_count_non_negative', sql`${table.redispatchCount} >= 0`),

    check('orders_photo_count_non_negative', sql`${table.photoCount} >= 0`),

    /**
     * A price with no master, or an accept time with no master, is a row that
     * contradicts ADR-0013. The implication runs one way only: a master may be
     * assigned to an inspection-priced order that still has no amount.
     */
    check(
      'orders_price_requires_master',
      sql`${table.priceMinor} is null or ${table.masterId} is not null`,
    ),
    check(
      'orders_accepted_at_requires_master',
      sql`${table.acceptedAt} is null or ${table.masterId} is not null`,
    ),
  ],
);

/**
 * Who caused a status change.
 *
 * Mirrors `master_verification_actor_kind` rather than reusing it: the two
 * enums happen to share values today, and sharing a type would mean a future
 * order-only actor kind silently becoming a legal value in a verification
 * audit row.
 */
export const orderActorKind = pgEnum('order_actor_kind', ['customer', 'master', 'admin', 'system']);

/**
 * Every status change an order has ever made. **Append-only.**
 *
 * Enforced by a trigger installed in the migration, not by convention — the
 * same choice `master_verification_history` made. `orders.status` is the
 * current value and nothing more; the answer to "when did this order stop
 * searching, and who stopped it" only exists here.
 */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    fromStatus: orderStatus('from_status').notNull(),
    toStatus: orderStatus('to_status').notNull(),

    actorKind: orderActorKind('actor_kind').notNull(),

    /**
     * The consumer account behind a `customer` or `master` transition. Null for
     * `admin` and `system`.
     *
     * A master is a `users` row and an admin is not (ADR-0014), which is why
     * one polymorphic `actor_id` would have had to be a `uuid` pointing at
     * nothing enforceable.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),

    /** The admin account behind an `admin` transition. Null otherwise. */
    actorAdminId: uuid('actor_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),

    /**
     * Why. Mandatory for a dispute outcome and for an admin override
     * (ADR-0015), enforced in the service rather than here: which pairs of
     * statuses demand a reason is policy, and a CHECK would freeze that policy
     * into the shape of the table.
     */
    reason: text('reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One order's trail, in the order it happened. Ascending rather than
     * descending because an audit read is a story, and a story is read
     * forwards (`docs/architecture/database-architecture.md` § Indexing).
     */
    index('order_status_history_order_idx').on(table.orderId, table.createdAt),

    /**
     * Who did what, across orders — the admin-action review in EPIC 13.
     *
     * Descending written as `sql` for the reason `orders_customer_created_idx`
     * gives: neither has a consumer yet, which is exactly when a `DESC NULLS
     * LAST` index is invisible — the query that would have exposed it has not
     * been written (#191).
     */
    index('order_status_history_actor_admin_idx')
      .on(table.actorAdminId, sql`${table.createdAt} desc`)
      .where(sql`${table.actorAdminId} is not null`),

    index('order_status_history_actor_user_idx')
      .on(table.actorUserId, sql`${table.createdAt} desc`)
      .where(sql`${table.actorUserId} is not null`),

    /**
     * A transition from a status to itself is not a transition — it is either
     * a no-op somebody logged or a bug that misread the current status.
     */
    check('order_status_history_real_transition', sql`${table.fromStatus} <> ${table.toStatus}`),

    /**
     * Exactly the right actor column is filled for each kind. `system` names
     * nobody, which is the point of having it.
     */
    check(
      'order_status_history_actor_shape',
      sql`(${table.actorKind} in ('customer', 'master')) = (${table.actorUserId} is not null)
          and (${table.actorKind} = 'admin') = (${table.actorAdminId} is not null)`,
    ),

    check(
      'order_status_history_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 600`,
    ),
  ],
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  address: one(addresses, { fields: [orders.addressId], references: [addresses.id] }),
  service: one(services, { fields: [orders.serviceId], references: [services.id] }),
  master: one(masters, { fields: [orders.masterId], references: [masters.id] }),
  statusHistory: many(orderStatusHistory),
}));

export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({
  order: one(orders, { fields: [orderStatusHistory.orderId], references: [orders.id] }),
  actorUser: one(users, { fields: [orderStatusHistory.actorUserId], references: [users.id] }),
  actorAdmin: one(adminUsers, {
    fields: [orderStatusHistory.actorAdminId],
    references: [adminUsers.id],
  }),
}));

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderStatusHistoryRow = typeof orderStatusHistory.$inferSelect;
export type NewOrderStatusHistoryRow = typeof orderStatusHistory.$inferInsert;

/**
 * The column type and the wire contract describe the same set, and the
 * compiler is made to say so in both directions.
 *
 * Without this, adding a status to `packages/types` and forgetting the enum
 * typechecks everywhere and then fails at runtime against a value Postgres
 * rejects — in the order pipeline, at the worst possible moment. Each alias
 * below fails to compile if either set gains a value the other lacks.
 */
type AssertNever<T extends never> = T;

/** No status exists in the column that the API contract cannot name. */
export type OrderStatusEnumHasNoStrangers = AssertNever<
  Exclude<(typeof orderStatus.enumValues)[number], OrderStatus>
>;
/** And none exists in the contract that the column cannot store. */
export type OrderStatusEnumIsComplete = AssertNever<
  Exclude<OrderStatus, (typeof orderStatus.enumValues)[number]>
>;
export type OrderActorKindEnumHasNoStrangers = AssertNever<
  Exclude<(typeof orderActorKind.enumValues)[number], OrderActorKind>
>;
export type OrderActorKindEnumIsComplete = AssertNever<
  Exclude<OrderActorKind, (typeof orderActorKind.enumValues)[number]>
>;
