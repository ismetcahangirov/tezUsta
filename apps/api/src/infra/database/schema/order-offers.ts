import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { masters } from './masters';
import { orders } from './orders';

/**
 * What has happened to one offer, fixed by
 * [ADR-0009](docs/decisions/ADR-0009-dispatch-model.md).
 *
 * **`declined` and `expired` are not the same fact, and the difference is the
 * whole reason this table exists rather than a Redis set.** ADR-0009 makes a
 * decline permanent — a master who declines is never shown that order again,
 * in any later round — while an unactioned offer that times out is not a
 * refusal and may be re-offered once the radius widens. Collapsing the two
 * into one "gone" value would make "declined is forever" unenforceable: the
 * database would have no way to tell a widening round which rows it may
 * touch again and which it must leave alone.
 *
 * **`lost` is its own value rather than a symptom of `expired`.** It is the
 * master who tapped accept and did not win the race — ADR-0009 calls a stale
 * offer that fails on tap a support ticket, and `lost` is what turns that
 * ticket into a durable, queryable answer instead of an offer that silently
 * disappeared from the feed.
 */
export const orderOfferStatus = pgEnum('order_offer_status', [
  'offered',
  'declined',
  'expired',
  'accepted',
  'lost',
]);

/**
 * One broadcast offer: this order, shown to this master, in this round.
 *
 * **Not append-only**, unlike `order_status_history` and
 * `master_verification_history`. Those tables record what already happened
 * and are never allowed to change; this table *is* the state a master's offer
 * is currently in, and a master responding is exactly the row changing state
 * under them — installing an immutability trigger here would make the
 * dispatch engine's own writes illegal. The audit trail of a dispatch is this
 * table's rows plus `order_status_history`, not a second history table
 * layered on top of it.
 *
 * **One row per `(order_id, master_id)`, ever** — see the unique index below.
 * A widening round that wants to re-offer an order to a master it already
 * reached does so by updating this row (extending `expires_at`, bumping
 * `round`), never by inserting a second one. That single choice is what makes
 * "declined is forever" a database guarantee rather than a habit the
 * dispatch engine has to remember on every round.
 */
export const orderOffers = pgTable(
  'order_offers',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    /**
     * Which broadcast round produced this offer. Starts at 1 and increases
     * each time the radius widens without a winner (ADR-0009). Kept on the
     * row rather than inferred from `created_at` because a widening round
     * updates the existing row in place — the round number is the only
     * record of how many times this particular master has been reached.
     */
    round: integer('round').notNull(),

    /**
     * The search radius, in metres, that this round used. Not the distance to
     * this master — that is `distance_m` below — but the boundary the round
     * was broadcasting within, kept so a support question about why a round
     * did or did not reach a given master can be answered from the row
     * instead of reconstructed from configuration history.
     */
    radiusM: integer('radius_m').notNull(),

    /**
     * How far this master was from the job when this offer was made, in
     * metres. **Stored, not recomputed** — it is the figure the master was
     * actually shown, and a master who accepted a "2–3 km" job that turns out
     * to be 9 km away needs the platform to know which figure it quoted
     * rather than re-deriving a different one after the fact. It is also why
     * the offer card can render a distance band without re-running a spatial
     * query per card.
     *
     * Never the customer's address, and never joined to one for the offer
     * card (`docs/product/master-flow.md`) — this column is the whole reason
     * `address_id` does not need to be, and must not be, on this row.
     */
    distanceM: integer('distance_m').notNull(),

    /**
     * No default, matching `orders.status`. A row is created by the dispatch
     * engine at exactly one status, `offered`, and a default here would let a
     * future insert somewhere else silently pick a starting value instead of
     * stating it.
     */
    status: orderOfferStatus('status').notNull(),

    /** When an unactioned `offered` row stops being live. ADR-0009 §Parameters. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * When the master's response was recorded — a decline, an accept, or the
     * loss of the race. Null for `offered` and `expired`, because neither of
     * those is a response: nobody acted, or the window simply ran out. The
     * CHECK below is what keeps the two states of "no response" and "the
     * master did something" from drifting apart on some future writer.
     */
    respondedAt: timestamp('responded_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **One offer row per master per order, across every round.** This is the
     * constraint ADR-0009's "declined is forever" rule depends on: a widening
     * round re-offers by updating the existing row, and this index is what
     * makes inserting a second one for the same pair impossible rather than
     * merely discouraged.
     */
    uniqueIndex('order_offers_order_master_unique').on(table.orderId, table.masterId),

    /**
     * The offer feed's only query: a master's own live offers, newest first.
     * Without `status` in the index, "what is currently offered to me" would
     * have to filter the master's entire offer history — including every
     * `declined` and `expired` row ever accumulated — on every poll.
     */
    index('order_offers_master_status_created_idx').on(
      table.masterId,
      table.status,
      table.createdAt.desc(),
    ),

    /** This order's own offers — read when an accept closes the rest out. */
    index('order_offers_order_idx').on(table.orderId),

    check('order_offers_round_positive', sql`${table.round} >= 1`),
    check('order_offers_radius_positive', sql`${table.radiusM} > 0`),
    check('order_offers_distance_non_negative', sql`${table.distanceM} >= 0`),

    /**
     * `responded_at` is set for exactly the statuses that carry a response —
     * `declined`, `accepted`, `lost` — and null for the two that do not,
     * `offered` and `expired`. Same shape as `masters_suspension_consistent`:
     * without it, a `declined` row with no response time and an `offered` row
     * with one are both writable, and each misleads a different reader.
     */
    check(
      'order_offers_response_consistent',
      sql`(${table.status} in ('declined', 'accepted', 'lost')) = (${table.respondedAt} is not null)`,
    ),
  ],
);

/**
 * Unidirectional, like `orderPhotosRelations` — `orders.ts` does not declare
 * the reverse `many(orderOffers)`. Nothing yet needs to load every offer
 * through a relational query starting from an order; the accept path and the
 * dispatch engine both start from an offer or a master and query outward.
 */
export const orderOffersRelations = relations(orderOffers, ({ one }) => ({
  order: one(orders, { fields: [orderOffers.orderId], references: [orders.id] }),
  master: one(masters, { fields: [orderOffers.masterId], references: [masters.id] }),
}));

export type OrderOfferRow = typeof orderOffers.$inferSelect;
export type NewOrderOfferRow = typeof orderOffers.$inferInsert;

/**
 * **Not cross-checked against `packages/types`.** Unlike `OrderStatus` and
 * `OrderPhotoStatus`, this table is not a wire shape yet — the offer card
 * contract belongs to the feed issue, not this one (issue #99) — so there is
 * no contract type on the other side of an `AssertNever` guard to keep in
 * step with. Adding one prematurely would mean inventing the wire shape here,
 * which is exactly what this issue defers.
 */
export type OrderOfferStatusName = (typeof orderOfferStatus.enumValues)[number];
