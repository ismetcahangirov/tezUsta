import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { masters } from './masters';
import { subscriptionBillingPeriod, subscriptionPrices } from './subscriptions';

/**
 * Taking money for a subscription period (issue #323, ADR-0046 § 6, ADR-0057).
 *
 * Two tables, both **append-only** — enforced by the triggers in
 * `0052_subscription_billing.sql`, as `subscription_events` is:
 *
 * - `subscription_checkouts` — every hosted checkout TezUsta opened at the
 *   provider, with the price version and amount fixed when it was opened.
 * - `subscription_payments` — every verified provider event about one of
 *   them, exactly once per provider event id.
 *
 * **Neither stores card data**, nor anything a card could be rebuilt from: the
 * card is typed into the provider's own page, and all TezUsta keeps is the
 * provider's reference for the checkout. PCI scope stays at zero.
 */

/** A provider's name, as `BILLING_PROVIDER` spells it. */
const PROVIDER_NAME = (column: AnyPgColumn) => sql`${column} ~ '^[a-z][a-z0-9-]{0,31}$'`;

/**
 * One hosted checkout. **The amount is the server's**, from the price version
 * current when the master asked (ADR-0046 § 5): a price change after this row
 * is written does not change what this checkout charges, because the payment
 * activates against `price_id` here, not against whatever is current when the
 * webhook lands.
 *
 * `id` is also the idempotency key handed to the provider, so a retried
 * `createCheckout` for the same row opens no second checkout there.
 *
 * Two kinds (ADR-0058):
 *
 * - `hosted` — a page the master opened and pays on. `save_card` records
 *   whether they asked for auto-renewal there; only then is the card's token
 *   kept.
 * - `renewal` — a charge TezUsta made on a saved card before the period
 *   ended. No page; `renews_period_end` names the period it renews, and one
 *   renewal per master per period end is all there can ever be.
 */
export const subscriptionCheckoutKind = pgEnum('subscription_checkout_kind', ['hosted', 'renewal']);

/** Why a saved card stopped being used. */
export const subscriptionPaymentMethodRevokedReason = pgEnum(
  'subscription_payment_method_revoked_reason',
  ['master', 'replaced'],
);

/**
 * The card a master saved for auto-renewal (ADR-0046 § 6, ADR-0058): the
 * **provider's token reference** for it, and nothing about the card itself.
 * The token is useless without TezUsta's merchant credentials, which is why
 * holding it keeps PCI scope at zero — but it still lets us charge the card,
 * so it is never logged or returned.
 *
 * At most one live row per master. A row is never deleted — the renewal
 * checkouts point at it — and the only change it ever takes is being revoked:
 * by the master, or by a newer card replacing it.
 */
export const subscriptionPaymentMethods = pgTable(
  'subscription_payment_methods',
  {
    id: uuid('id').primaryKey(),
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    tokenRef: text('token_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: subscriptionPaymentMethodRevokedReason('revoked_reason'),
  },
  (table) => [
    /** One live card per master — the guarantee, and the renewal job's lookup. */
    uniqueIndex('subscription_payment_methods_one_live')
      .on(table.masterId)
      .where(sql`${table.revokedAt} is null`),
    /** Every foreign key gets one (#288). */
    index('subscription_payment_methods_master_idx').on(table.masterId),
    check('subscription_payment_methods_provider_shape', PROVIDER_NAME(table.provider)),
    check(
      'subscription_payment_methods_token_ref_length',
      sql`length(${table.tokenRef}) between 1 and 512`,
    ),
    check(
      'subscription_payment_methods_revoked_shape',
      sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`,
    ),
  ],
);

export const subscriptionCheckouts = pgTable(
  'subscription_checkouts',
  {
    id: uuid('id').primaryKey(),
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),
    billingPeriod: subscriptionBillingPeriod('billing_period').notNull(),
    priceId: uuid('price_id')
      .notNull()
      .references(() => subscriptionPrices.id, { onDelete: 'restrict' }),
    /** Copied from the price version, so the checkout reads without a join. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    provider: text('provider').notNull(),
    /** The provider's own reference for this checkout; every webhook names it. */
    providerRef: text('provider_ref').notNull(),
    kind: subscriptionCheckoutKind('kind').notNull().default('hosted'),
    /**
     * The provider's hosted page, handed back to a repeated request rather
     * than opening a second checkout. Null for a renewal, which has no page.
     */
    checkoutUrl: text('checkout_url'),
    /** A hosted checkout on which the master asked for auto-renewal (ADR-0058). */
    saveCard: boolean('save_card').notNull().default(false),
    /** A renewal: the end of the period it renews. */
    renewsPeriodEnd: timestamp('renews_period_end', { withTimezone: true }),
    /** A renewal: the saved card it charged. */
    paymentMethodId: uuid('payment_method_id').references(() => subscriptionPaymentMethods.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The webhook's lookup: which checkout does this event belong to? */
    uniqueIndex('subscription_checkouts_provider_ref_unique').on(table.provider, table.providerRef),
    /**
     * "This master's newest checkout" — the reuse check on every checkout
     * request — and the index the foreign key needs (#288).
     */
    index('subscription_checkouts_master_created_idx').on(
      table.masterId,
      sql`${table.createdAt} desc`,
    ),
    /** Every foreign key gets one (#288). */
    index('subscription_checkouts_price_idx').on(table.priceId),
    /** The reconciliation window, newest first. */
    index('subscription_checkouts_created_idx').on(sql`${table.createdAt} desc`),
    check('subscription_checkouts_amount_positive', sql`${table.amountMinor} > 0`),
    check('subscription_checkouts_currency_azn', sql`${table.currency} = 'AZN'`),
    check('subscription_checkouts_provider_shape', PROVIDER_NAME(table.provider)),
    check(
      'subscription_checkouts_provider_ref_length',
      sql`length(${table.providerRef}) between 1 and 160`,
    ),
    check(
      'subscription_checkouts_checkout_url_shape',
      sql`${table.checkoutUrl} is null
          or (${table.checkoutUrl} ~ '^https://' and length(${table.checkoutUrl}) <= 2048)`,
    ),
    check(
      'subscription_checkouts_kind_shape',
      sql`case ${table.kind}
            when 'hosted' then ${table.checkoutUrl} is not null
                           and ${table.renewsPeriodEnd} is null
                           and ${table.paymentMethodId} is null
            else ${table.checkoutUrl} is null
                 and not ${table.saveCard}
                 and ${table.renewsPeriodEnd} is not null
                 and ${table.paymentMethodId} is not null
          end`,
    ),
    /** One renewal charge per master per period: the job's idempotency. */
    uniqueIndex('subscription_checkouts_one_renewal_per_period')
      .on(table.masterId, table.renewsPeriodEnd)
      .where(sql`${table.kind} = 'renewal'`),
    /** Every foreign key gets one (#288). */
    index('subscription_checkouts_payment_method_idx')
      .on(table.paymentMethodId)
      .where(sql`${table.paymentMethodId} is not null`),
  ],
);

/** What the provider said happened to a checkout's payment. */
export const subscriptionPaymentKind = pgEnum('subscription_payment_kind', [
  'succeeded',
  'failed',
  'refunded',
]);

/**
 * What TezUsta did about one provider event — so an operator reading the table
 * after an alert sees which events changed a subscription and which did not,
 * and why.
 *
 * - `activated` — a success that bought a period (`activatePeriod`, #322).
 * - `already_applied` — a success for a payment that had already bought its
 *   period: a second event about the same payment.
 * - `recorded` — a failure or a refund, kept as history. Neither changes the
 *   period: a failed charge lets the period lapse into grace on its own, and a
 *   refund is recorded, not enforced (ADR-0046 § 5, ADR-0057).
 * - `amount_mismatch` — the provider says a different amount or currency was
 *   paid than the checkout asked for. Nothing is activated.
 * - `unknown_checkout` — the event names a reference no checkout here holds.
 * - `period_already_queued` — paid, but a bought period was already waiting,
 *   and prepaid stacking holds one. The money needs a person.
 */
export const subscriptionPaymentDisposition = pgEnum('subscription_payment_disposition', [
  'activated',
  'already_applied',
  'recorded',
  'amount_mismatch',
  'unknown_checkout',
  'period_already_queued',
]);

/**
 * Every verified provider event, once. `(provider, provider_event_id)` is
 * unique: it is what makes the webhook idempotent, so a provider delivering
 * the same event twice — or twice at the same moment — leaves one row.
 *
 * `provider_ref` is **not** unique here, unlike the issue's sketch: one
 * payment legitimately has several events — a success and later its refund, or
 * a failed attempt and then a successful one on the same hosted page. The
 * guarantee that one payment buys one period is `subscription_events`'
 * unique `payment_ref`, which `activatePeriod` already relies on (#322).
 */
export const subscriptionPayments = pgTable(
  'subscription_payments',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    providerRef: text('provider_ref').notNull(),
    /** Null when no checkout holds `provider_ref` (`unknown_checkout`). */
    checkoutId: uuid('checkout_id').references(() => subscriptionCheckouts.id, {
      onDelete: 'restrict',
    }),
    kind: subscriptionPaymentKind('kind').notNull(),
    disposition: subscriptionPaymentDisposition('disposition').notNull(),
    /** As the provider reported it. Null when the event carried none, as a failure may not. */
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    currency: text('currency'),
    /** When the provider says it happened. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subscription_payments_event_unique').on(table.provider, table.providerEventId),
    /** Reconciliation reads a checkout's events by its reference. */
    index('subscription_payments_provider_ref_idx').on(table.provider, table.providerRef),
    /** Every foreign key gets one (#288). */
    index('subscription_payments_checkout_idx')
      .on(table.checkoutId)
      .where(sql`${table.checkoutId} is not null`),
    check('subscription_payments_provider_shape', PROVIDER_NAME(table.provider)),
    check(
      'subscription_payments_event_id_length',
      sql`length(${table.providerEventId}) between 1 and 200`,
    ),
    check(
      'subscription_payments_provider_ref_length',
      sql`length(${table.providerRef}) between 1 and 160`,
    ),
    check(
      'subscription_payments_amount_shape',
      sql`(${table.amountMinor} is null) = (${table.currency} is null)
          and (${table.amountMinor} is null or ${table.amountMinor} >= 0)`,
    ),
    check(
      'subscription_payments_currency_shape',
      sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'subscription_payments_unknown_has_no_checkout',
      sql`(${table.disposition} = 'unknown_checkout') = (${table.checkoutId} is null)`,
    ),
  ],
);

export type SubscriptionCheckoutRow = typeof subscriptionCheckouts.$inferSelect;
export type SubscriptionPaymentMethodRow = typeof subscriptionPaymentMethods.$inferSelect;
export type SubscriptionPaymentRow = typeof subscriptionPayments.$inferSelect;
export type SubscriptionPaymentKind = (typeof subscriptionPaymentKind.enumValues)[number];
export type SubscriptionPaymentDisposition =
  (typeof subscriptionPaymentDisposition.enumValues)[number];
