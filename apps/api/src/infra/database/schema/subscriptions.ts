import type { SubscriptionBillingPeriod, SubscriptionStatus } from '@tezusta/types';
import { relations, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { adminUsers } from './admin';
import { masters } from './masters';

/**
 * The master subscription (ADR-0046 § 5, issue #322).
 *
 * Four tables, and each one exists for a different reason:
 *
 * - `subscription_settings` — the admin-editable knobs: trial, grace, and
 *   whether purchases are open. One row.
 * - `subscription_prices` — what a period costs, **versioned and never
 *   edited**, so the price a master paid is still the price on record after
 *   the next change.
 * - `master_subscriptions` — where each master stands **now**. One row per
 *   master; the current value and nothing more.
 * - `subscription_events` — how they got there. Append-only, like
 *   `admin_audit_log`: it is the only answer to "why was this master not
 *   receiving work on 3 March".
 *
 * The append-only and single-row rules are enforced by triggers and CHECKs
 * installed in `0038_master_subscriptions.sql`, not by convention.
 */

export const subscriptionBillingPeriod = pgEnum('subscription_billing_period', [
  'monthly',
  'yearly',
]);

export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
]);

/**
 * What one `subscription_events` row records.
 *
 * - `trial_started` — verification approved the master (EPIC 5).
 * - `period_activated` — a payment started a period now.
 * - `period_queued` — a payment bought a period that starts when the running
 *   one ends (prepaid stacking).
 * - `period_granted` — an admin gave days, with a reason.
 * - `queued_period_started` — the running period ended and the queued one took over.
 * - `cancelled` — the master stopped renewal.
 * - `grace_entered` — a period ended unpaid.
 * - `expired` — past the period end and past grace.
 */
export const subscriptionEventKind = pgEnum('subscription_event_kind', [
  'trial_started',
  'period_activated',
  'period_queued',
  'period_granted',
  'queued_period_started',
  'cancelled',
  'grace_entered',
  'expired',
]);

/**
 * The subscription's admin-editable settings. **Exactly one row**, id 1.
 *
 * A table rather than environment variables because ADR-0046 § 5 makes these
 * admin data: changing the trial length is not a release. The constant
 * primary key and the CHECK are what keep it one row — an `INSERT` of a second
 * row fails rather than creating a second, disagreeing answer.
 *
 * Seeded by the migration with purchases **closed**. The trial and grace
 * lengths were given by the owner on 11 October 2026; #324 lets an admin
 * change them.
 */
export const subscriptionSettings = pgTable(
  'subscription_settings',
  {
    id: smallint('id').primaryKey().default(1),

    /**
     * Read when a trial **starts**, so a change applies to trials started
     * after it (ADR-0046 § 5). `0` means no trial.
     */
    trialDays: integer('trial_days').notNull(),

    /**
     * Read when a period **lapses** into grace, so a change applies to lapses
     * after it.
     */
    graceDays: integer('grace_days').notNull(),

    purchasesOpen: boolean('purchases_open').notNull().default(false),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /** Null until an admin first edits the row (#324): the migration seeded it. */
    updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    // One row, so this index never serves a read. It is here because every
    // foreign key gets one (#288): deleting an admin must not scan this table.
    index('subscription_settings_updated_by_admin_idx').on(table.updatedByAdminId),
    check('subscription_settings_single_row', sql`${table.id} = 1`),
    // The bounds #324 enforces at the admin surface, repeated here so a
    // hand-written UPDATE cannot step outside them either.
    check('subscription_settings_trial_days_range', sql`${table.trialDays} between 0 and 90`),
    check('subscription_settings_grace_days_range', sql`${table.graceDays} between 0 and 30`),
  ],
);

/**
 * What a billing period costs, from when. **Append-only**: a price change is
 * a new row, and `UPDATE` and `DELETE` are refused by a trigger.
 *
 * The current price of a period is its newest row whose `effective_from` has
 * passed. A paid period points at the row it was paid against
 * (`subscription_events.price_id`), so editing a price in place would rewrite
 * what every earlier payment says it cost.
 */
export const subscriptionPrices = pgTable(
  'subscription_prices',
  {
    id: uuid('id').primaryKey(),
    billingPeriod: subscriptionBillingPeriod('billing_period').notNull(),
    /**
     * Integer minor units (ADR-0010 § Money representation). Null only on a
     * withdrawal row, which records that a scheduled version was withdrawn
     * and carries no price of its own (#324).
     */
    priceMinor: bigint('price_minor', { mode: 'number' }),
    currency: text('currency').notNull().default('AZN'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    /**
     * Set on a withdrawal row: the scheduled version it withdrew (#324). The
     * history is never edited or deleted, so withdrawing a price is a row of
     * its own, and the current-price read skips both rows.
     */
    withdrawsPriceId: uuid('withdraws_price_id').references(
      (): AnyPgColumn => subscriptionPrices.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * "The current monthly price": the newest version that has taken effect,
     * the most recently entered first when two share an `effective_from`.
     */
    index('subscription_prices_period_effective_idx').on(
      table.billingPeriod,
      sql`${table.effectiveFrom} desc`,
      sql`${table.createdAt} desc`,
    ),
    /** Every foreign key gets an index (#288) — and "prices this admin set" is #324's history. */
    index('subscription_prices_created_by_admin_idx').on(table.createdByAdminId),
    /** A version is withdrawn at most once; also the index #288 asks for on this foreign key. */
    uniqueIndex('subscription_prices_withdraws_unique')
      .on(table.withdrawsPriceId)
      .where(sql`${table.withdrawsPriceId} is not null`),
    check(
      'subscription_prices_price_positive',
      sql`${table.priceMinor} is null or ${table.priceMinor} > 0`,
    ),
    check(
      'subscription_prices_withdrawal_shape',
      sql`(${table.withdrawsPriceId} is null) = (${table.priceMinor} is not null)`,
    ),
    check('subscription_prices_currency_azn', sql`${table.currency} = 'AZN'`),
  ],
);

/**
 * Where one master's subscription stands **now**. One row per master.
 *
 * Written only by `SubscriptionsService`, through a conditional UPDATE and an
 * event row in one transaction. The history is `subscription_events`.
 *
 * **Entitlement is one predicate** (`subscription-entitlement.ts`), evaluated
 * by the database at the moment it matters — the dispatch query and the accept
 * re-check — and never read from a token claim, as verification is not
 * (ADR-0023).
 */
export const masterSubscriptions = pgTable(
  'master_subscriptions',
  {
    id: uuid('id').primaryKey(),

    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    status: subscriptionStatus('status').notNull(),

    /** The period last bought. Null while trialing, and when every period so far was granted. */
    billingPeriod: subscriptionBillingPeriod('billing_period'),

    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),

    /**
     * When grace runs out. Set when the period lapses unpaid, from the grace
     * length at that moment; null otherwise.
     */
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),

    /**
     * A period already paid for that starts when the current one ends
     * (ADR-0046 § 5, prepaid stacking). At most one: a second purchase while
     * one is queued is refused.
     */
    nextBillingPeriod: subscriptionBillingPeriod('next_billing_period'),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One current row per master — and the index the dispatch join probes, so
     * the entitlement term is an index lookup per candidate, never a scan.
     */
    uniqueIndex('master_subscriptions_master_unique').on(table.masterId),

    /**
     * The sweep's two questions — "whose period has ended" and "whose grace
     * has ended" — over the rows that can still move. `expired` is terminal
     * for the sweep, and it is where most rows end up, so leaving it out keeps
     * both indexes the size of the live population.
     */
    index('master_subscriptions_period_end_due_idx')
      .on(table.currentPeriodEnd)
      .where(sql`${table.status} <> 'expired'`),
    index('master_subscriptions_grace_end_due_idx')
      .on(table.graceEndsAt)
      .where(sql`${table.status} <> 'expired' and ${table.graceEndsAt} is not null`),
    /**
     * "Who renews on this period" — the price-change notice's question (#326).
     * The queued period if one is queued, since renewal renews the period last
     * bought (ADR-0046 § 6). Over the subscriptions that will renew at all; `id`
     * second, for the sweep's ordered, bounded batches.
     */
    index('master_subscriptions_renewal_period_idx')
      .on(sql`coalesce(${table.nextBillingPeriod}, ${table.billingPeriod})`, table.id)
      .where(sql`${table.status} in ('trialing', 'active', 'past_due')`),

    check(
      'master_subscriptions_period_order',
      sql`${table.currentPeriodEnd} >= ${table.currentPeriodStart}`,
    ),
    check(
      'master_subscriptions_trial_has_no_billing_period',
      sql`${table.status} <> 'trialing' or ${table.billingPeriod} is null`,
    ),
    check(
      'master_subscriptions_past_due_has_grace',
      sql`${table.status} <> 'past_due' or ${table.graceEndsAt} is not null`,
    ),
    check(
      'master_subscriptions_cancelled_has_timestamp',
      sql`${table.status} <> 'cancelled' or ${table.cancelledAt} is not null`,
    ),
  ],
);

/**
 * Every transition a subscription has made. **Append-only**, enforced by a
 * trigger, like `admin_audit_log`.
 *
 * `payment_ref` is unique where present: it is what makes activating a period
 * idempotent, so a provider that delivers the same confirmation twice extends
 * the period once (#323).
 */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').primaryKey(),

    masterSubscriptionId: uuid('master_subscription_id')
      .notNull()
      .references(() => masterSubscriptions.id, { onDelete: 'restrict' }),

    kind: subscriptionEventKind('kind').notNull(),

    /** Null for the event that created the subscription. */
    fromStatus: subscriptionStatus('from_status'),
    toStatus: subscriptionStatus('to_status').notNull(),

    /** The period this event concerns — the new one, or the one that ended. */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    billingPeriod: subscriptionBillingPeriod('billing_period'),

    /** The price version paid against. Null for a trial, a grant, or a sweep. */
    priceId: uuid('price_id').references(() => subscriptionPrices.id, { onDelete: 'restrict' }),
    /** Copied from the price row, so the amount reads without a join and outlives nothing. */
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    paymentRef: text('payment_ref'),

    /** `system`, `provider`, or `admin:<uuid>`. */
    actor: text('actor').notNull(),
    reason: text('reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One subscription's story, in order. `id` breaks ties within a transaction. */
    index('subscription_events_subscription_idx').on(
      table.masterSubscriptionId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex('subscription_events_payment_ref_unique')
      .on(table.paymentRef)
      .where(sql`${table.paymentRef} is not null`),
    index('subscription_events_price_idx')
      .on(table.priceId)
      .where(sql`${table.priceId} is not null`),
    check(
      'subscription_events_actor_shape',
      sql`${table.actor} in ('system', 'provider') or ${table.actor} ~ '^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    check(
      'subscription_events_payment_shape',
      sql`(${table.priceId} is null) = (${table.amountMinor} is null)
          and (${table.priceId} is null) = (${table.paymentRef} is null)`,
    ),
    check(
      'subscription_events_payment_ref_length',
      sql`${table.paymentRef} is null or length(${table.paymentRef}) between 1 and 200`,
    ),
    check(
      'subscription_events_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 600`,
    ),
    check('subscription_events_period_order', sql`${table.periodEnd} >= ${table.periodStart}`),
  ],
);

/** Which subscription push a `subscription_notices` row stands for (#326). */
export const subscriptionNoticeKind = pgEnum('subscription_notice_kind', [
  'ending',
  'grace',
  'expired',
  'renewed',
  'price_change',
]);

/**
 * Every subscription push a master has been sent, so each is sent once (#326).
 *
 * The de-duplication lives here rather than in a BullMQ job id: the queue
 * keeps only its last hundred completed jobs, so a job id stops guarding
 * against a second send as soon as it is evicted. A row here is written in the
 * same transaction as the transition it reports — or, for the sweep's
 * three-day warning and the price notice, claimed before the push is raised —
 * and the unique key makes a second claim a no-op.
 *
 * `dedup_key` is the period end the push is about (as ISO-8601), or for a
 * price notice the price version's id: one warning per period, one notice per
 * price change.
 */
export const subscriptionNotices = pgTable(
  'subscription_notices',
  {
    id: uuid('id').primaryKey(),
    masterSubscriptionId: uuid('master_subscription_id')
      .notNull()
      .references(() => masterSubscriptions.id, { onDelete: 'restrict' }),
    kind: subscriptionNoticeKind('kind').notNull(),
    dedupKey: text('dedup_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The guarantee, and the index the foreign key needs (#288). */
    uniqueIndex('subscription_notices_once').on(
      table.masterSubscriptionId,
      table.kind,
      table.dedupKey,
    ),
    check('subscription_notices_dedup_key_length', sql`length(${table.dedupKey}) between 1 and 64`),
  ],
);

export const masterSubscriptionsRelations = relations(masterSubscriptions, ({ one, many }) => ({
  master: one(masters, { fields: [masterSubscriptions.masterId], references: [masters.id] }),
  events: many(subscriptionEvents),
}));

export const subscriptionEventsRelations = relations(subscriptionEvents, ({ one }) => ({
  subscription: one(masterSubscriptions, {
    fields: [subscriptionEvents.masterSubscriptionId],
    references: [masterSubscriptions.id],
  }),
  price: one(subscriptionPrices, {
    fields: [subscriptionEvents.priceId],
    references: [subscriptionPrices.id],
  }),
}));

export type SubscriptionSettingsRow = typeof subscriptionSettings.$inferSelect;
export type SubscriptionPriceRow = typeof subscriptionPrices.$inferSelect;
export type MasterSubscriptionRow = typeof masterSubscriptions.$inferSelect;
export type SubscriptionEventRow = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEventRow = typeof subscriptionEvents.$inferInsert;
export type SubscriptionEventKind = (typeof subscriptionEventKind.enumValues)[number];
export type SubscriptionNoticeKind = (typeof subscriptionNoticeKind.enumValues)[number];

/** The column types and the wire contract name the same sets, in both directions. */
type AssertNever<T extends never> = T;
export type SubscriptionStatusEnumHasNoStrangers = AssertNever<
  Exclude<(typeof subscriptionStatus.enumValues)[number], SubscriptionStatus>
>;
export type SubscriptionStatusEnumIsComplete = AssertNever<
  Exclude<SubscriptionStatus, (typeof subscriptionStatus.enumValues)[number]>
>;
export type SubscriptionBillingPeriodEnumHasNoStrangers = AssertNever<
  Exclude<(typeof subscriptionBillingPeriod.enumValues)[number], SubscriptionBillingPeriod>
>;
export type SubscriptionBillingPeriodEnumIsComplete = AssertNever<
  Exclude<SubscriptionBillingPeriod, (typeof subscriptionBillingPeriod.enumValues)[number]>
>;
