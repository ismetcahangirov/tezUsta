import type { ReviewAuthorRole } from '@tezusta/types';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { adminUsers } from './admin';
import { customers } from './customers';
import { masters } from './masters';
import { orders } from './orders';

/**
 * Which side of the order wrote a review (issue #221). A `customer` review is
 * about the master; a `master` review is about the customer.
 *
 * Its own enum rather than a reuse of `message_sender_kind` or
 * `call_party_kind`, although the two strings are the same: each of those
 * means something else, and the day one concept gains a value the others must
 * not silently gain it too.
 */
export const reviewAuthorRole = pgEnum('review_author_role', ['customer', 'master']);

/**
 * One party's review of the other, for one order
 * ([ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **A review about any pair of people other than the order's customer and
 * master is unrepresentable here.** The composite foreign key below points
 * `(order_id, customer_id, master_id)` at the same triple on `orders`, so the
 * two parties a review names are, by construction, the two parties the order
 * names. That is the constraint half of "a review needs a completed order
 * between exactly those two parties" (user-roles invariant 5); the other half
 * — the caller is that side, the order is in a reviewable status, the window
 * is open — crosses tables and time, and is the service's (ADR-0042
 * § Integrity).
 *
 * The composite key also subsumes the single-column references: `orders`
 * already refers `customer_id` to `customers` and `master_id` to `masters`, so
 * a matching triple cannot name a customer or master that does not exist, and
 * a second set of foreign keys would be three more checks per insert proving
 * the same thing.
 *
 * **Sealed until `revealed_at` is set** (ADR-0042 § 3). While sealed a review
 * is its author's only, is editable, and counts towards no aggregate; the
 * reveal is a stored moment rather than a computed condition, so "may the
 * other party see this?" is a column read.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id').notNull(),

    /**
     * Copied from the order, and held to it by the composite foreign key.
     * Stored rather than joined because the aggregate reads — "revealed
     * reviews about this master" — must be an index probe on this table, not
     * a join through `orders`.
     */
    customerId: uuid('customer_id').notNull(),

    /**
     * Not null, although `orders.master_id` is nullable: a review only exists
     * for an order that reached `COMPLETED`, and no order does that without a
     * master.
     */
    masterId: uuid('master_id').notNull(),

    authorRole: reviewAuthorRole('author_role').notNull(),

    /** 1–5, no half stars (ADR-0042 § 5). */
    rating: smallint('rating').notNull(),

    /**
     * Untrusted free text shown to another person. Stored as written and never
     * interpreted; the request schema trims it, strips control characters and
     * turns an empty string into null, and the CHECK below restates the bound
     * for every writer that is not the request path.
     */
    comment: text('comment'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    /**
     * When the review became visible to the party it is about, and began to
     * count. Set once — by the second party's submission or by the window
     * closing — through a guarded `UPDATE … WHERE revealed_at IS NULL`.
     */
    revealedAt: timestamp('revealed_at', { withTimezone: true }),

    /**
     * Moderation (ADR-0042 § 7): a soft removal, because the record of what was
     * said and why it was taken down is what a later complaint needs. The three
     * columns are one fact, held together by a CHECK below.
     */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByAdminId: uuid('removed_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    removalReason: text('removal_reason'),
  },
  (table) => [
    /**
     * **The two parties of the review are the two parties of the order.**
     * Targets `orders_id_parties_unique`, which exists for no other reason.
     */
    foreignKey({
      name: 'reviews_order_parties_fk',
      columns: [table.orderId, table.customerId, table.masterId],
      foreignColumns: [orders.id, orders.customerId, orders.masterId],
    }).onDelete('restrict'),

    /**
     * One review per side per order. Leading with `order_id`, it is also the
     * index the composite foreign key's referential check uses when an order
     * row changes, and the lookup behind "this order's reviews".
     */
    uniqueIndex('reviews_order_author_unique').on(table.orderId, table.authorRole),

    /**
     * What a master reads about themselves, and what the recalculation sums:
     * customer-written reviews about one master that are revealed and not
     * removed. Partial, so sealed and removed rows never enter the structure.
     * A plain `desc` in `sql` for the reason `orders_customer_created_idx`
     * gives (#191).
     */
    index('reviews_about_master_idx')
      .on(table.masterId, sql`${table.revealedAt} desc`)
      .where(
        sql`${table.authorRole} = 'customer' and ${table.revealedAt} is not null and ${table.removedAt} is null`,
      ),

    /** The same read, from the other side: master-written reviews about one customer. */
    index('reviews_about_customer_idx')
      .on(table.customerId, sql`${table.revealedAt} desc`)
      .where(
        sql`${table.authorRole} = 'master' and ${table.revealedAt} is not null and ${table.removedAt} is null`,
      ),

    /**
     * The reveal sweep's worklist (ADR-0042 § 3): sealed reviews, by order.
     * In a healthy system that is the reviews of the last week, however many
     * have ever been written.
     */
    index('reviews_sealed_order_idx')
      .on(table.orderId)
      .where(sql`${table.revealedAt} is null`),

    /**
     * The admin's moderation listing (#224): every review — sealed, revealed
     * and removed alike — about one master, about one customer, or all of
     * them, newest written first on the `(created_at, id)` keyset. The partial
     * indexes above cannot serve it, because they leave out exactly the rows
     * an admin most needs to see. A plain `desc` in `sql` for #191's reason.
     */
    index('reviews_master_created_idx').on(
      table.masterId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('reviews_customer_created_idx').on(
      table.customerId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),
    index('reviews_created_idx').on(sql`${table.createdAt} desc`, sql`${table.id} desc`),

    /** The one remaining foreign key, which Postgres does not index on its own. */
    index('reviews_removed_by_admin_idx')
      .on(table.removedByAdminId)
      .where(sql`${table.removedByAdminId} is not null`),

    check('reviews_rating_range', sql`${table.rating} between 1 and 5`),

    /**
     * At most 500 characters (ADR-0042 § 5), and never empty: an empty comment
     * is stored as null, so a whitespace-only string here is a writer that
     * skipped the request schema.
     */
    check(
      'reviews_comment_length',
      sql`${table.comment} is null or (char_length(${table.comment}) <= 500 and length(btrim(${table.comment})) >= 1)`,
    ),

    /**
     * A removal names its moment, its admin and its reason, or none of them. A
     * half-set trio is a removal nobody can account for.
     */
    check(
      'reviews_removal_complete',
      sql`(${table.removedAt} is null) = (${table.removedByAdminId} is null)
          and (${table.removedAt} is null) = (${table.removalReason} is null)`,
    ),

    check(
      'reviews_removal_reason_length',
      sql`${table.removalReason} is null or length(btrim(${table.removalReason})) between 1 and 600`,
    ),
  ],
);

export const reviewsRelations = relations(reviews, ({ one }) => ({
  order: one(orders, { fields: [reviews.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [reviews.customerId], references: [customers.id] }),
  master: one(masters, { fields: [reviews.masterId], references: [masters.id] }),
  removedByAdmin: one(adminUsers, {
    fields: [reviews.removedByAdminId],
    references: [adminUsers.id],
  }),
}));

export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;

/**
 * The column type and the wire contract describe the same set, in both
 * directions — the check `orders.ts` makes for `order_status` (issue #222).
 */
type AssertNever<T extends never> = T;
export type ReviewAuthorRoleEnumHasNoStrangers = AssertNever<
  Exclude<(typeof reviewAuthorRole.enumValues)[number], ReviewAuthorRole>
>;
export type ReviewAuthorRoleEnumIsComplete = AssertNever<
  Exclude<ReviewAuthorRole, (typeof reviewAuthorRole.enumValues)[number]>
>;
