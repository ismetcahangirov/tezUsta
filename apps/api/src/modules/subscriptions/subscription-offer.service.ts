import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminSubscription,
  AdminSubscriptionPriceState,
  AdminSubscriptionPriceVersion,
  SubscriptionBillingPeriod,
} from '@tezusta/types';

import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type {
  SubscriptionPriceRow,
  SubscriptionSettingsRow,
} from '../../infra/database/schema/subscriptions';
import { addCalendarDays, addCalendarMonths } from './subscription-period';
import { SubscriptionOfferError } from './subscriptions.errors';
import type { SubscriptionAuditRecorder } from './subscriptions.repository';
import { SubscriptionsRepository } from './subscriptions.repository';
import { toPrice } from './subscriptions.service';

/**
 * How far ahead a changed price must be entered once anyone has paid for its
 * period (ADR-0046 § 5): masters on auto-renewal are told before it applies.
 */
export const PRICE_CHANGE_NOTICE_DAYS = 30;

/** The furthest ahead a price may be scheduled (#324). */
const MAX_SCHEDULE_AHEAD_MONTHS = 12;

/**
 * The typo guard (#324): a change to at least twice or at most half the
 * current price needs `confirmLargeChange`. A first price above this needs it
 * too, since there is nothing to compare it with — 1 000 AZN, where a
 * monthly 10.00 typed as 1000 would land.
 */
const LARGE_CHANGE_FACTOR = 2;
const FIRST_PRICE_CONFIRM_ABOVE_MINOR = 100_000;

/** A request timestamp a little in the past is "now", not an attempt to backdate. */
const CLOCK_SKEW_MS = 60_000;

const PRICE_HISTORY_LIMIT = 200;

/** The whole subscription is one audit target; its id is the nil uuid, as the catalogue's is. */
export const SUBSCRIPTION_AUDIT_TARGET_ID = '00000000-0000-0000-0000-000000000000';

const PERIODS: readonly SubscriptionBillingPeriod[] = ['monthly', 'yearly'];

function versionOf(
  row: SubscriptionPriceRow,
  state: AdminSubscriptionPriceState,
): AdminSubscriptionPriceVersion {
  return {
    id: row.id,
    billingPeriod: row.billingPeriod,
    priceMinor: row.priceMinor,
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdByAdminId: row.createdByAdminId,
    withdrawsPriceId: row.withdrawsPriceId,
    state,
  };
}

function settingsFields(row: SubscriptionSettingsRow): Record<string, unknown> {
  return {
    trialDays: row.trialDays,
    graceDays: row.graceDays,
    purchasesOpen: row.purchasesOpen,
  };
}

/**
 * The admin side of the subscription offer (ADR-0046 § 5, issue #324): both
 * prices, trial, grace and whether purchases are open.
 *
 * Every edit takes the offer's advisory lock, makes its checks against what
 * the database holds under that lock, writes, and calls `record` — the admin
 * audit writer — inside the same transaction, so an edit and its audit row
 * commit together or not at all.
 *
 * Prices are never edited: a change is a new version (`subscription_prices`
 * is append-only, #322), and withdrawing a scheduled one is a row of its own.
 */
@Injectable()
export class SubscriptionOfferService {
  constructor(
    private readonly repository: SubscriptionsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async read(): Promise<AdminSubscription> {
    const now = this.clock.now();
    const [settings, current, scheduled, history, withdrawn, paidMonthly, paidYearly] =
      await Promise.all([
        this.repository.readSettings(),
        this.repository.currentPrices(now),
        this.repository.scheduledPrices(now),
        this.repository.priceHistory(PRICE_HISTORY_LIMIT),
        this.repository.withdrawnPriceIds(),
        this.repository.hasBeenPaid('monthly'),
        this.repository.hasBeenPaid('yearly'),
      ]);

    const currentIds = new Set(current.map((row) => row.id));
    const stateOf = (row: SubscriptionPriceRow): AdminSubscriptionPriceState => {
      if (row.withdrawsPriceId !== null) return 'withdrawal';
      if (withdrawn.has(row.id)) return 'withdrawn';
      if (currentIds.has(row.id)) return 'current';
      return row.effectiveFrom.getTime() > now.getTime() ? 'scheduled' : 'superseded';
    };
    const scheduledFor = (period: SubscriptionBillingPeriod) => {
      const row = scheduled.find((price) => price.billingPeriod === period);
      return row === undefined ? null : versionOf(row, 'scheduled');
    };

    return {
      monthly: toPrice(current.find((row) => row.billingPeriod === 'monthly')),
      yearly: toPrice(current.find((row) => row.billingPeriod === 'yearly')),
      scheduled: { monthly: scheduledFor('monthly'), yearly: scheduledFor('yearly') },
      trialDays: settings.trialDays,
      graceDays: settings.graceDays,
      purchasesOpen: settings.purchasesOpen,
      priceChangeNoticeDays: PRICE_CHANGE_NOTICE_DAYS,
      noticeRequired: { monthly: paidMonthly, yearly: paidYearly },
      priceHistory: history.map((row) => versionOf(row, stateOf(row))),
    };
  }

  /**
   * A new price version for one or both periods, from `effectiveFrom`.
   *
   * - A period someone has paid for takes a change no sooner than (ADR-0047)
   *   {@link PRICE_CHANGE_NOTICE_DAYS} from now. Before anyone has paid —
   *   launch, while prices are still being set — a change may apply at once.
   * - `effectiveFrom` defaults to the earliest moment every changed period
   *   allows, may not be in the past, and is at most a year ahead.
   * - One scheduled version per period: a second is refused until the first
   *   is withdrawn or has taken effect.
   * - A price that at least doubles or halves needs `confirmLargeChange`.
   */
  async changePrices(
    input: {
      readonly monthlyMinor?: number | undefined;
      readonly yearlyMinor?: number | undefined;
      readonly effectiveFrom?: Date | undefined;
      readonly confirmLargeChange?: boolean | undefined;
      readonly adminUserId: string;
    },
    record: SubscriptionAuditRecorder,
  ): Promise<AdminSubscription> {
    const requested = PERIODS.flatMap((period) => {
      const priceMinor = period === 'monthly' ? input.monthlyMinor : input.yearlyMinor;
      return priceMinor === undefined ? [] : [{ period, priceMinor }];
    });
    if (requested.length === 0) {
      throw new RangeError('A price change names at least one period.');
    }

    await this.repository.transaction(async (tx) => {
      await this.repository.lockOffer(tx);
      const now = this.clock.now();
      const [current, scheduled] = await Promise.all([
        this.repository.currentPrices(now, tx),
        this.repository.scheduledPrices(now, tx),
      ]);

      let earliest = now;
      for (const { period } of requested) {
        if (scheduled.some((row) => row.billingPeriod === period)) {
          throw new SubscriptionOfferError(
            'SUBSCRIPTION_PRICE_ALREADY_SCHEDULED',
            `A ${period} price is already scheduled. Withdraw it first.`,
            { billingPeriod: period },
          );
        }
        if (await this.repository.hasBeenPaid(period, tx)) {
          const noticeEnds = addCalendarDays(now, PRICE_CHANGE_NOTICE_DAYS);
          if (noticeEnds.getTime() > earliest.getTime()) earliest = noticeEnds;
        }
      }

      const effectiveFrom = this.effectiveFrom(input.effectiveFrom, now, earliest);

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const { period, priceMinor } of requested) {
        const replaced = current.find((row) => row.billingPeriod === period)?.priceMinor ?? null;
        this.assertConfirmed(period, replaced, priceMinor, input.confirmLargeChange === true);
        await this.repository.insertPrice(tx, {
          billingPeriod: period,
          priceMinor,
          effectiveFrom,
          adminUserId: input.adminUserId,
          now,
        });
        before[period] = { priceMinor: replaced };
        after[period] = { priceMinor, effectiveFrom: effectiveFrom.toISOString() };
      }

      await record(tx, { targetId: SUBSCRIPTION_AUDIT_TARGET_ID, before, after });
    });
    // The masters on a period whose price is changing are told by the
    // subscription sweep, which picks up every scheduled version (#326).
    return this.read();
  }

  /** Withdraws a scheduled version before it takes effect. The history keeps both rows. */
  async withdrawPrice(
    priceId: string,
    adminUserId: string,
    record: SubscriptionAuditRecorder,
  ): Promise<AdminSubscription> {
    await this.repository.transaction(async (tx) => {
      await this.repository.lockOffer(tx);
      const now = this.clock.now();
      const scheduled = await this.repository.scheduledPrices(now, tx);
      const target = scheduled.find((row) => row.id === priceId);
      if (target === undefined) {
        throw new SubscriptionOfferError(
          'SUBSCRIPTION_PRICE_NOT_SCHEDULED',
          'Only a scheduled price that has not taken effect can be withdrawn.',
        );
      }

      await this.repository.insertPrice(tx, {
        billingPeriod: target.billingPeriod,
        priceMinor: null,
        effectiveFrom: now,
        adminUserId,
        withdrawsPriceId: target.id,
        now,
      });
      await record(tx, {
        targetId: SUBSCRIPTION_AUDIT_TARGET_ID,
        before: {
          [target.billingPeriod]: {
            scheduled: {
              priceId: target.id,
              priceMinor: target.priceMinor,
              effectiveFrom: target.effectiveFrom.toISOString(),
            },
          },
        },
        after: { [target.billingPeriod]: { scheduled: null } },
      });
    });
    return this.read();
  }

  /**
   * Trial, grace and whether purchases are open. A trial change applies to
   * trials started from now on and a grace change to lapses from now on
   * (#322 reads both at that moment), so neither rewrites a running period.
   * Purchases cannot open while either period has no current price.
   */
  async updateSettings(
    input: {
      readonly trialDays?: number | undefined;
      readonly graceDays?: number | undefined;
      readonly purchasesOpen?: boolean | undefined;
      readonly adminUserId: string;
    },
    record: SubscriptionAuditRecorder,
  ): Promise<AdminSubscription> {
    await this.repository.transaction(async (tx: DatabaseExecutor) => {
      await this.repository.lockOffer(tx);
      const now = this.clock.now();
      const before = await this.repository.readSettings(tx);

      if (input.purchasesOpen === true) {
        const current = await this.repository.currentPrices(now, tx);
        const missing = PERIODS.filter(
          (period) => !current.some((row) => row.billingPeriod === period),
        );
        if (missing.length > 0) {
          throw new SubscriptionOfferError(
            'SUBSCRIPTION_PURCHASES_NEED_PRICES',
            'Purchases cannot open until both periods have a price in effect.',
            { missing },
          );
        }
      }

      const after = await this.repository.updateSettings(
        tx,
        {
          trialDays: input.trialDays,
          graceDays: input.graceDays,
          purchasesOpen: input.purchasesOpen,
        },
        input.adminUserId,
        now,
      );
      await record(tx, {
        targetId: SUBSCRIPTION_AUDIT_TARGET_ID,
        before: settingsFields(before),
        after: settingsFields(after),
      });
    });
    return this.read();
  }

  private effectiveFrom(requested: Date | undefined, now: Date, earliest: Date): Date {
    if (requested === undefined) {
      return earliest;
    }
    if (requested.getTime() < now.getTime() - CLOCK_SKEW_MS) {
      throw new SubscriptionOfferError(
        'SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID',
        'A price cannot take effect in the past.',
      );
    }
    if (requested.getTime() > addCalendarMonths(now, MAX_SCHEDULE_AHEAD_MONTHS).getTime()) {
      throw new SubscriptionOfferError(
        'SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID',
        'A price can be scheduled at most a year ahead.',
      );
    }
    if (requested.getTime() < earliest.getTime()) {
      throw new SubscriptionOfferError(
        'SUBSCRIPTION_PRICE_NOTICE_REQUIRED',
        `Masters have paid for this period, so a new price takes effect no sooner than ${String(PRICE_CHANGE_NOTICE_DAYS)} days from now.`,
        { earliestEffectiveFrom: earliest.toISOString() },
      );
    }
    return requested.getTime() < now.getTime() ? now : requested;
  }

  private assertConfirmed(
    period: SubscriptionBillingPeriod,
    currentMinor: number | null,
    requestedMinor: number,
    confirmed: boolean,
  ): void {
    if (confirmed) {
      return;
    }
    const large =
      currentMinor === null
        ? requestedMinor > FIRST_PRICE_CONFIRM_ABOVE_MINOR
        : requestedMinor >= currentMinor * LARGE_CHANGE_FACTOR ||
          requestedMinor * LARGE_CHANGE_FACTOR <= currentMinor;
    if (large) {
      throw new SubscriptionOfferError(
        'SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED',
        'This is a large change. Check the amount and confirm it.',
        { billingPeriod: period, currentMinor, requestedMinor },
      );
    }
  }
}
