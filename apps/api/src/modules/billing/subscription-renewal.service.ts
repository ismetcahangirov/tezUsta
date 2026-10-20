import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import type { SubscriptionAutoRenewal } from '@tezusta/types';

import { uuidV7 } from '../../common/ids/uuid-v7';
import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import { BILLING_PROVIDER } from '../../infra/billing/billing.types';
import type { SubscriptionBillingProvider } from '../../infra/billing/billing.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import type { Actor } from '../auth/auth.types';
import { MastersService } from '../masters/masters.service';
import {
  SubscriptionPeriodAlreadyQueuedError,
  SubscriptionPurchasesClosedError,
} from '../subscriptions/subscriptions.errors';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { RenewalCandidate } from './billing.repository';
import { BillingRepository } from './billing.repository';
import { MAX_RENEWALS_PER_RUN, SUBSCRIPTION_RENEWAL_JOB } from './billing.constants';

const HOUR_MS = 60 * 60 * 1000;

/** What one renewal run did. Counts only. */
export interface RenewalRunReport {
  /** Charges started at the provider. Each one's outcome arrives as a webhook. */
  readonly charged: number;
  /** Purchases closed, or a bought period already queued: tried again next run. */
  readonly deferred: number;
  /** The price changed and its notice is not in the ledger: not charged. */
  readonly awaitingNotice: number;
  /** The provider call failed: tried again next run. */
  readonly failed: number;
}

type Outcome = 'charged' | 'deferred' | 'awaitingNotice' | 'already';

/**
 * Auto-renewal on a saved card (ADR-0046 § 6, ADR-0058).
 *
 * **The schedule is TezUsta's, not the provider's.** Every
 * `SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS` this finds the `active` periods
 * ending within `SUBSCRIPTION_RENEWAL_LEAD_HOURS` whose master saved a card,
 * and starts **one** charge per period on it, at the price current now. The
 * charge's outcome arrives like any payment, through the verified webhook,
 * which is still the only thing that extends a period: a success queues the
 * next period behind the running one, and a failure lets the period lapse into
 * grace on its own, where the master renews by hand.
 *
 * A renewal is refused, and tried again next run, while purchases are closed
 * or a bought period is already queued — `quoteCheckout`'s own refusals. It
 * is **not charged at all** while the price has changed since the master last
 * paid and the price-change push for that version is not in the ledger:
 * a price change reaches a renewal only after its notice (ADR-0046 § 5–6).
 *
 * At most once per period: the renewal is written as a checkout row with
 * `renews_period_end`, which is unique per master, and checked under the
 * master's checkout lock before the provider is called. That row's id is the
 * provider's idempotency key, so a retried run cannot charge twice either.
 */
@Injectable()
export class SubscriptionRenewalService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly masters: MastersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly recurring: RecurringWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(BILLING_PROVIDER) private readonly provider: SubscriptionBillingProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.handlers.register(SUBSCRIPTION_RENEWAL_JOB, async () => {
      await this.renewDue();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.billing.renewalIntervalSeconds;
    if (seconds === 0) {
      await this.recurring.stop(SUBSCRIPTION_RENEWAL_JOB);
      this.logger.log('SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS=0 — no saved card is charged');
      return;
    }
    await this.recurring.every(SUBSCRIPTION_RENEWAL_JOB, seconds * 1000);
  }

  /** Whether the calling master has a card that will be charged for the next period. */
  async status(actor: Actor): Promise<SubscriptionAutoRenewal> {
    const master = await this.masters.getOwn(actor);
    const card = await this.repository.findLivePaymentMethod(master.id, this.provider.name);
    return { enabled: card !== undefined };
  }

  /**
   * The master turns auto-renewal off: the saved card is revoked and never
   * charged again. What is running runs to its end. Idempotent.
   */
  async disable(actor: Actor): Promise<void> {
    const master = await this.masters.getOwn(actor);
    await this.repository.revokePaymentMethod(master.id, this.clock.now());
  }

  /** One pass. Public so a test, or an operator, can run one on demand. */
  async renewDue(): Promise<RenewalRunReport> {
    const now = this.clock.now();
    const until = new Date(now.getTime() + this.config.billing.renewalLeadHours * HOUR_MS);
    const candidates = await this.repository.listRenewalCandidates(
      this.provider.name,
      now,
      until,
      MAX_RENEWALS_PER_RUN,
    );

    const counts = { charged: 0, deferred: 0, awaitingNotice: 0, failed: 0 };
    for (const candidate of candidates) {
      let outcome: Outcome;
      try {
        outcome = await this.renewOne(candidate, now);
      } catch {
        counts.failed += 1;
        continue;
      }
      if (outcome !== 'already') {
        counts[outcome] += 1;
      }
    }

    if (counts.awaitingNotice > 0) {
      this.logger.error(
        `Subscription renewal: ${String(counts.awaitingNotice)} renewals were not charged because ` +
          'their price changed without a price-change notice in the ledger. They will lapse into grace.',
      );
    }
    if (counts.failed > 0) {
      this.logger.warn(
        `Subscription renewal: ${String(counts.failed)} charges could not be started at ` +
          `"${this.provider.name}"; the next run tries again.`,
      );
    }
    return counts;
  }

  private async renewOne(candidate: RenewalCandidate, now: Date): Promise<Outcome> {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockCheckouts(tx, candidate.masterId);
      if (await this.repository.hasRenewalFor(tx, candidate.masterId, candidate.currentPeriodEnd)) {
        return 'already';
      }

      let quote: Awaited<ReturnType<SubscriptionsService['quoteCheckout']>>;
      try {
        quote = await this.subscriptions.quoteCheckout(
          candidate.masterId,
          candidate.billingPeriod,
          tx,
        );
      } catch (error) {
        if (
          error instanceof SubscriptionPurchasesClosedError ||
          error instanceof SubscriptionPeriodAlreadyQueuedError
        ) {
          return 'deferred';
        }
        throw error;
      }
      if (!(await this.subscriptions.renewalPriceNoticed(candidate.masterId, quote.priceId))) {
        return 'awaitingNotice';
      }

      const id = uuidV7();
      const charge = await this.provider.chargeSavedCard({
        masterId: candidate.masterId,
        billingPeriod: candidate.billingPeriod,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        tokenRef: candidate.tokenRef,
        idempotencyKey: id,
      });
      await this.repository.insertCheckout(tx, {
        id,
        masterId: candidate.masterId,
        billingPeriod: candidate.billingPeriod,
        priceId: quote.priceId,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        provider: this.provider.name,
        providerRef: charge.providerRef,
        kind: 'renewal',
        checkoutUrl: null,
        saveCard: false,
        renewsPeriodEnd: candidate.currentPeriodEnd,
        paymentMethodId: candidate.paymentMethodId,
        createdAt: now,
      });
      return 'charged';
    });
  }
}
