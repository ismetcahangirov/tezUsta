/**
 * The master subscription (ADR-0046 § 5, issue #322).
 *
 * There is exactly one subscription. A master buys it monthly or yearly, and
 * each billing period has its own admin-editable price. Receiving work is
 * what it entitles a master to.
 */

/** How long one paid period lasts: one calendar month or one calendar year in `Asia/Baku`. */
export type SubscriptionBillingPeriod = 'monthly' | 'yearly';

/**
 * Where a master's subscription stands.
 *
 * - `trialing`: the free trial that starts when verification approves them.
 * - `active`: a paid or admin-granted period is running.
 * - `past_due`: the period ended unpaid and the master is in grace. They still
 *   receive work until `graceEndsAt`.
 * - `cancelled`: the master stopped renewal. The period runs to its end and
 *   does not renew.
 * - `expired`: past the period end and past grace. No offers, and the master
 *   cannot go available.
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

/** One billing period's current price, in minor units. */
export interface SubscriptionPrice {
  readonly billingPeriod: SubscriptionBillingPeriod;
  readonly priceMinor: number;
  readonly currency: 'AZN';
  /** ISO-8601. When this price took effect. */
  readonly effectiveFrom: string;
}

/**
 * The subscription as it is offered today — `GET /subscription`.
 *
 * A period with no price yet is `null`. Purchases stay closed until both have
 * one (ADR-0046 § 5).
 */
export interface SubscriptionOffer {
  readonly monthly: SubscriptionPrice | null;
  readonly yearly: SubscriptionPrice | null;
  readonly trialDays: number;
  readonly graceDays: number;
  readonly purchasesOpen: boolean;
}

/** The calling master's own subscription — `GET /masters/me/subscription`. */
export interface MasterSubscription {
  readonly status: SubscriptionStatus;
  /** `null` while trialing, and for a master whose only periods were granted. */
  readonly billingPeriod: SubscriptionBillingPeriod | null;
  /** ISO-8601. */
  readonly currentPeriodStart: string;
  /** ISO-8601. */
  readonly currentPeriodEnd: string;
  /** ISO-8601, set while `past_due`. */
  readonly graceEndsAt: string | null;
  /** A period already paid for that starts when the current one ends (prepaid stacking). */
  readonly nextBillingPeriod: SubscriptionBillingPeriod | null;
  /** Whether the server would include this master in a broadcast right now, on this term alone. */
  readonly entitled: boolean;
}
