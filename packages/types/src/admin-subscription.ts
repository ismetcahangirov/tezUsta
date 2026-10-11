import type {
  MasterSubscription,
  SubscriptionBillingPeriod,
  SubscriptionPrice,
  SubscriptionStatus,
} from './subscription.js';

/**
 * The admin surface of the master subscription (ADR-0046 § 5, issue #324).
 * Every write carries a mandatory reason and is audited in the same
 * transaction as the change.
 */

/**
 * Where one price version stands.
 *
 * - `current`: the price a checkout uses now.
 * - `scheduled`: entered, takes effect at `effectiveFrom`, can still be withdrawn.
 * - `superseded`: was current once and a newer version replaced it.
 * - `withdrawn`: was scheduled and withdrawn before it took effect.
 * - `withdrawal`: the row that records a withdrawal. It carries no price.
 */
export type AdminSubscriptionPriceState =
  'current' | 'scheduled' | 'superseded' | 'withdrawn' | 'withdrawal';

/** One row of `subscription_prices`, as the price history shows it. Newest entered first. */
export interface AdminSubscriptionPriceVersion {
  readonly id: string;
  readonly billingPeriod: SubscriptionBillingPeriod;
  /** `null` only for a `withdrawal` row. */
  readonly priceMinor: number | null;
  readonly effectiveFrom: string;
  readonly createdAt: string;
  readonly createdByAdminId: string;
  /** The scheduled version a `withdrawal` row withdrew. */
  readonly withdrawsPriceId: string | null;
  readonly state: AdminSubscriptionPriceState;
}

/** `GET /admin/subscription`. */
export interface AdminSubscription {
  readonly monthly: SubscriptionPrice | null;
  readonly yearly: SubscriptionPrice | null;
  /** A price entered for a later date and not yet in effect, per period. */
  readonly scheduled: {
    readonly monthly: AdminSubscriptionPriceVersion | null;
    readonly yearly: AdminSubscriptionPriceVersion | null;
  };
  readonly trialDays: number;
  readonly graceDays: number;
  readonly purchasesOpen: boolean;
  /**
   * The notice a price change needs once anyone has paid for that period
   * (ADR-0046 § 5): the earliest it may take effect is this many days out.
   */
  readonly priceChangeNoticeDays: number;
  /** Per period: has anyone ever paid for it? If so, a change needs the notice. */
  readonly noticeRequired: {
    readonly monthly: boolean;
    readonly yearly: boolean;
  };
  readonly priceHistory: readonly AdminSubscriptionPriceVersion[];
}

/** `PUT /admin/subscription/prices`. At least one price. */
export interface ChangeSubscriptionPricesRequest {
  readonly monthlyMinor?: number;
  readonly yearlyMinor?: number;
  /** ISO-8601. Defaults to the earliest moment the change may take effect. */
  readonly effectiveFrom?: string;
  /** Required when a price at least doubles or at least halves, or a first price is unusually high. */
  readonly confirmLargeChange?: boolean;
  readonly reason: string;
}

/** `PUT /admin/subscription/settings`. At least one setting. */
export interface UpdateSubscriptionSettingsRequest {
  readonly trialDays?: number;
  readonly graceDays?: number;
  readonly purchasesOpen?: boolean;
  readonly reason: string;
}

/** `POST /admin/subscription/prices/:id/withdraw`. */
export interface WithdrawSubscriptionPriceRequest {
  readonly reason: string;
}

/** One entry of a master's subscription history, newest first. */
export interface AdminSubscriptionEvent {
  readonly kind: string;
  readonly fromStatus: SubscriptionStatus | null;
  readonly toStatus: SubscriptionStatus;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly billingPeriod: SubscriptionBillingPeriod | null;
  /** What the period was paid at. `null` for a trial, a grant, or a sweep step. */
  readonly amountMinor: number | null;
  /** `system`, `provider` or `admin:<id>`. */
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** `GET /admin/masters/:id/subscription`. `subscription` is null before approval. */
export interface AdminMasterSubscription {
  readonly subscription: MasterSubscription | null;
  readonly events: readonly AdminSubscriptionEvent[];
}

/** `POST /admin/masters/:id/subscription/grant`. 1–366 days. */
export interface GrantSubscriptionRequest {
  readonly days: number;
  readonly reason: string;
}

/** `POST /admin/masters/:id/subscription/cancel`. */
export interface CancelSubscriptionRequest {
  readonly reason: string;
}

/** The subscription counters on `GET /admin/dashboard`. Counts of masters, now. */
export interface AdminDashboardSubscriptions {
  readonly trialing: number;
  readonly activeMonthly: number;
  readonly activeYearly: number;
  /** Running on granted days only: no billing period was ever bought. */
  readonly activeGranted: number;
  readonly inGrace: number;
  /** Subscriptions that expired in the last seven days. */
  readonly expiredLast7Days: number;
}
