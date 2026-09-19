import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { services } from './services';
import { users } from './users';

/**
 * Where a master stands with the platform's trust gate.
 *
 * These five values are not invented here — they are the account states
 * already settled in `docs/product/user-roles.md`, and
 * [ADR-0023](docs/decisions/ADR-0023-master-verification-policy.md) is what
 * fixed the policy that moves a master between them.
 *
 * **`changes_requested` and `rejected` are deliberately not the same value.**
 * One asks for something the master can do; the other must not pretend there
 * is anything to do (`docs/product/master-flow.md`). Collapsing them into a
 * single "not approved" would leave the app unable to tell a master which of
 * the two happened, which is exactly the screen that matters most to someone
 * waiting on an income.
 *
 * **`deleted` is absent on purpose.** user-roles.md lists it among the account
 * states, but `masters.deleted_at` already carries deletion, and a fact stored
 * in two places is a fact that can disagree with itself. The first symptom
 * would be a soft-deleted master who is still dispatchable. Deletion is
 * `deleted_at is not null`; this enum carries the review states only
 * (ADR-0023 § Consequences).
 */
export const masterVerificationStatus = pgEnum('master_verification_status', [
  'pending_verification',
  'changes_requested',
  'rejected',
  'active',
  'suspended',
]);

/**
 * A master's **role profile** — not their account.
 *
 * Identity lives on `users`; this row is what that person is *as a master*, in
 * the same way `customers` is what they are as a customer. One human may hold
 * both, which is why neither table is the account and neither carries a phone
 * number.
 *
 * Nothing here decides whether a master may accept work on its own:
 * `verification_status` is the authority, and it is **re-read from this table
 * on every accept**, never taken from a token claim. An access token lives for
 * up to fifteen minutes, so a claim written before an admin suspended someone
 * is a claim that says the wrong thing for fifteen minutes
 * (`docs/architecture/authentication.md`).
 */
export const masters = pgTable(
  'masters',
  {
    id: uuid('id').primaryKey(),

    /**
     * `onDelete: 'restrict'`, like every other foreign key in this schema. A
     * user is soft-deleted, so a hard delete reaching this row is a mistake,
     * and the right response to a mistake is a failed write rather than a
     * silent cascade through a master's entire order history.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    displayName: text('display_name').notNull(),

    /** Free text the master writes about themselves. Optional, and bounded below. */
    bio: text('bio'),

    verificationStatus: masterVerificationStatus('verification_status')
      .notNull()
      .default('pending_verification'),

    /**
     * When the **current** suspension began — not a log of every suspension
     * that ever happened. That log is `master_verification_history`, and it is
     * the record; this column exists so the master's own app can say "since
     * 14 September" without reading an audit table.
     *
     * The CHECK below ties it to the status rather than trusting everyone who
     * ever writes here to keep the two in step. A `suspended_at` left behind
     * after a reinstatement is precisely the value a later query would read as
     * "still suspended".
     */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),

    /**
     * The master's **intent** to receive offers — one half of "online".
     *
     * The other half is liveness, held in Redis with a TTL and refreshed by a
     * heartbeat, and **matching requires both**
     * (`docs/architecture/realtime-architecture.md`). A boolean on its own has
     * no way to expire, so a phone that died in a tunnel would stay available
     * forever and dispatch would keep offering it work. The toggle that writes
     * this column lands with its Redis half in issue #40; the column is here
     * because the profile is where intent belongs.
     */
    isAvailable: boolean('is_available').notNull().default(false),

    /**
     * The rating aggregate, kept as **sum and count rather than an average**.
     *
     * An average cannot be updated incrementally without drifting: each
     * rewrite rounds, and the rounding compounds over thousands of reviews
     * until the number shown to a customer is not the number the reviews say.
     * Sum and count are both exact integers, the average is a division at read
     * time, and a recount to repair damage is a single aggregate query.
     *
     * Maintained by EPIC 11. Until then both stay at zero and the computed
     * average is null — a master with no reviews has no rating, which is not
     * the same as a rating of zero.
     */
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),

    /**
     * What this master owes the platform in commission on completed cash
     * orders — the brake issue #99 exists to add before dispatch has any
     * eligibility predicate to add it to. A card payment settles the
     * commission at the same instant it settles the master, so nothing about
     * a card order ever touches this column; a cash order lets the master
     * collect the whole amount and leaves the platform's cut as a debt, and
     * this is the running total of that debt.
     *
     * **Server-owned. No endpoint, DTO or Zod schema in this repository may
     * set it** — it reads `0` for every existing and new master until
     * EPIC 12 builds the ledger that writes it (ADR-0007, ADR-0010
     * §Commission). Shipping the column now rather than in EPIC 12 is
     * deliberate: it is a term in the accept predicate, and adding it later
     * would mean editing that predicate a second time rather than reading a
     * gate that has been sitting at zero since EPIC 5.
     */
    commissionDebtMinor: bigint('commission_debt_minor', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * Unique across every row, including soft-deleted ones — the same choice
     * `customers` made, for the same reason. A user id is never reassigned, so
     * a second profile for the same user is always a bug rather than a
     * legitimate reuse after deletion. Reviving the existing row is the
     * correct behaviour, and a full unique index is what forces the code to
     * do that instead of quietly inserting a duplicate.
     */
    uniqueIndex('masters_user_id_unique').on(table.userId),

    check('masters_display_name_length', sql`length(btrim(${table.displayName})) between 1 and 80`),

    check(
      'masters_bio_length',
      sql`${table.bio} is null or length(btrim(${table.bio})) between 1 and 600`,
    ),

    /**
     * Status and `suspended_at` say the same thing, so the database makes them
     * say it together. Without this, "suspended with no date" and "reinstated
     * but still stamped" are both writable, and each one misleads a different
     * reader.
     */
    check(
      'masters_suspension_consistent',
      sql`(${table.verificationStatus} = 'suspended') = (${table.suspendedAt} is not null)`,
    ),

    /**
     * A rating aggregate that cannot describe a real set of reviews is a bug
     * that would otherwise surface as a 7-star master. Five is the scale's
     * ceiling (EPIC 11); a sum above `count * 5` is arithmetically impossible.
     */
    check(
      'masters_rating_aggregate',
      sql`${table.ratingCount} >= 0 and ${table.ratingSum} >= 0 and ${table.ratingSum} <= ${table.ratingCount} * 5`,
    ),

    /**
     * A debt cannot be negative — that would be the platform owing the
     * master, which is not what this column records (a master's earnings are
     * a payout, not a credit against commission). Nothing in this repository
     * writes anything but `0` here yet, so this CHECK is the only thing
     * standing between "no writer exists" and "a bad writer arrives" until
     * EPIC 12 lands one.
     */
    check('masters_commission_debt_non_negative', sql`${table.commissionDebtMinor} >= 0`),
  ],
);

/**
 * Which catalogue services a master offers, and **what they charge for each**.
 *
 * The price here is the authoritative one
 * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)):
 * `services.base_price_minor` is what a customer is shown before choosing
 * anybody, and this is what an order actually freezes at accept
 * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)).
 *
 * There is no surrogate id. The pair *is* the identity of the row — a master
 * offers a service or does not — so `(master_id, service_id)` is the primary
 * key. That single choice also supplies the uniqueness constraint issue #37
 * asks for and the index on the `master_id` foreign key, instead of a
 * surrogate key plus a unique index plus an index, all describing the same
 * fact.
 */
export const masterServices = pgTable(
  'master_services',
  {
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),

    /**
     * Integer minor units — 15.00 AZN is `1500`, never `15.0`
     * (`docs/architecture/database-architecture.md` § Conventions). `mode:
     * 'number'` for the reason `services.base_price_minor` gives: a household
     * repair in AZN cannot approach 2^53, and a `BigInt` cannot be passed to
     * `JSON.stringify` at all.
     *
     * Null for an `inspection` service, where the amount does not exist until
     * a master has seen the work. That pairing is a **cross-table** invariant —
     * the pricing shape lives on `services` — so it is enforced in
     * `MastersService`, with its own tests, rather than in a CHECK that would
     * have to duplicate `services.pricing_kind` into this table and then keep
     * the copy in step forever.
     */
    priceMinor: bigint('price_minor', { mode: 'number' }),

    /**
     * Lets a master stop offering a service without losing the price they set
     * for it. Deleting the row is the other option and means "I do not do
     * this"; this flag means "not right now". Dispatch reads only active rows.
     */
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.masterId, table.serviceId] }),

    /**
     * **The matching filter, indexed before the incident rather than after.**
     *
     * EPIC 7 asks "which masters offer this service?", which reads
     * `service_id` first — the opposite order to the primary key, so the
     * primary key cannot serve it. Postgres does not index a foreign key on
     * its own either, so without this the referential check on a `services`
     * write is also a sequential scan.
     *
     * Partial on `is_active` because dispatch never wants an inactive row, and
     * a partial index keeps the paused offers out of the structure entirely.
     */
    index('master_services_service_master_idx')
      .on(table.serviceId, table.masterId)
      .where(sql`${table.isActive}`),

    /**
     * A free job is not a pricing shape — it is a different product decision,
     * and nobody has made it. Same reasoning as `services_pricing_shape`.
     */
    check(
      'master_services_price_positive',
      sql`${table.priceMinor} is null or ${table.priceMinor} > 0`,
    ),
  ],
);

export const mastersRelations = relations(masters, ({ one, many }) => ({
  user: one(users, { fields: [masters.userId], references: [users.id] }),
  services: many(masterServices),
}));

export const masterServicesRelations = relations(masterServices, ({ one }) => ({
  master: one(masters, { fields: [masterServices.masterId], references: [masters.id] }),
  service: one(services, { fields: [masterServices.serviceId], references: [services.id] }),
}));

export type MasterRow = typeof masters.$inferSelect;
export type NewMasterRow = typeof masters.$inferInsert;
export type MasterServiceRow = typeof masterServices.$inferSelect;
export type NewMasterServiceRow = typeof masterServices.$inferInsert;
export type MasterVerificationStatusName = (typeof masterVerificationStatus.enumValues)[number];
