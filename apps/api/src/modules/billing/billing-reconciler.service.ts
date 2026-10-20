import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import { BILLING_PROVIDER } from '../../infra/billing/billing.types';
import type { PaymentLookup, SubscriptionBillingProvider } from '../../infra/billing/billing.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import type { ReconciliationCandidate } from './billing.repository';
import { BillingRepository } from './billing.repository';
import { BILLING_RECONCILE_JOB, MAX_CHECKOUTS_PER_RECONCILE } from './billing.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one reconciliation run found. Counts only — never a reference, an amount or a master. */
export interface BillingReconciliationReport {
  readonly checked: number;
  /** The provider holds a payment we never recorded: a webhook that never arrived. */
  readonly unrecordedPayments: number;
  /** We recorded a payment the provider does not hold. */
  readonly unconfirmedPayments: number;
  /** The provider holds a different amount or currency than the checkout asked. */
  readonly amountMismatches: number;
  /** The provider refunded a payment and we never recorded the refund. */
  readonly unrecordedRefunds: number;
  /** The provider could not be asked. Not drift: the next run asks again. */
  readonly lookupFailures: number;
}

type Drift = Exclude<keyof BillingReconciliationReport, 'checked' | 'lookupFailures'>;

/** Where our record of one checkout and the provider's disagree. Pure. */
export function driftOf(candidate: ReconciliationCandidate, lookup: PaymentLookup): Drift[] {
  const found: Drift[] = [];
  const providerPaid = lookup.status === 'paid' || lookup.status === 'refunded';
  if (providerPaid && !candidate.recordedPaid) {
    found.push('unrecordedPayments');
  }
  if (!providerPaid && candidate.recordedPaid) {
    found.push('unconfirmedPayments');
  }
  if (
    providerPaid &&
    (lookup.amountMinor !== candidate.amountMinor || lookup.currency !== candidate.currency)
  ) {
    found.push('amountMismatches');
  }
  if (lookup.status === 'refunded' && !candidate.recordedRefund) {
    found.push('unrecordedRefunds');
  }
  return found;
}

/**
 * Compares the last `BILLING_RECONCILE_LOOKBACK_DAYS` of checkouts with what
 * the provider says about each, and **alerts** on any disagreement (issue
 * #323, EPIC 12's "scheduled reconciliation").
 *
 * **It corrects nothing.** The webhook is the source of truth for changing a
 * subscription (ADR-0046 § 6); a disagreement means something happened that
 * a person should look at — a webhook that never came, a payment reversed at
 * the provider — and activating a period from a lookup would make a second
 * writer of the thing the webhook alone writes. The alert is one
 * `logger.error` line with counts, the same channel the other reconcilers
 * use, and it names nothing about any master or payment.
 *
 * It asks about every checkout in the window, paid or not, because the case
 * it exists for is precisely the paid checkout we have no record of.
 *
 * On the `maintenance` queue as a BullMQ job scheduler, for
 * `DispatchReconciler`'s reasons: one scheduler however many replicas upsert
 * it, one worker per run, nothing in process.
 */
@Injectable()
export class BillingReconciler implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(BillingReconciler.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly recurring: RecurringWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(BILLING_PROVIDER) private readonly provider: SubscriptionBillingProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.handlers.register(BILLING_RECONCILE_JOB, async () => {
      await this.reconcile();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.billing.reconcileIntervalSeconds;
    if (seconds === 0) {
      // Zero means "nothing registered", including a scheduler an earlier
      // release left behind.
      await this.recurring.stop(BILLING_RECONCILE_JOB);
      this.logger.log('BILLING_RECONCILE_INTERVAL_SECONDS=0 — billing is not reconciled');
      return;
    }
    await this.recurring.every(BILLING_RECONCILE_JOB, seconds * 1000);
  }

  /** One pass. Public so a test, or an operator's script, can run one on demand. */
  async reconcile(): Promise<BillingReconciliationReport> {
    const since = new Date(
      this.clock.now().getTime() - this.config.billing.reconcileLookbackDays * DAY_MS,
    );
    const candidates = await this.repository.listForReconciliation(
      this.provider.name,
      since,
      MAX_CHECKOUTS_PER_RECONCILE,
    );

    const counts = {
      unrecordedPayments: 0,
      unconfirmedPayments: 0,
      amountMismatches: 0,
      unrecordedRefunds: 0,
    };
    let lookupFailures = 0;

    for (const candidate of candidates) {
      let lookup: PaymentLookup;
      try {
        lookup = await this.provider.fetchPayment(candidate.providerRef);
      } catch {
        lookupFailures += 1;
        continue;
      }
      for (const drift of driftOf(candidate, lookup)) {
        counts[drift] += 1;
      }
    }

    const report: BillingReconciliationReport = {
      checked: candidates.length,
      ...counts,
      lookupFailures,
    };
    const drifted =
      counts.unrecordedPayments +
      counts.unconfirmedPayments +
      counts.amountMismatches +
      counts.unrecordedRefunds;
    if (drifted > 0) {
      this.logger.error(
        `Billing reconciliation: our records and "${this.provider.name}" disagree — ` +
          `unrecorded payments ${String(counts.unrecordedPayments)}, ` +
          `unconfirmed payments ${String(counts.unconfirmedPayments)}, ` +
          `amount mismatches ${String(counts.amountMismatches)}, ` +
          `unrecorded refunds ${String(counts.unrecordedRefunds)}, ` +
          `of ${String(candidates.length)} checkouts checked.`,
      );
    }
    if (lookupFailures > 0) {
      this.logger.warn(
        `Billing reconciliation could not ask "${this.provider.name}" about ` +
          `${String(lookupFailures)} of ${String(candidates.length)} checkouts.`,
      );
    }
    return report;
  }
}
