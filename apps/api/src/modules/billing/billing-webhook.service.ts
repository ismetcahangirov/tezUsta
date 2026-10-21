import { Inject, Injectable, Logger } from '@nestjs/common';

import { BILLING_PROVIDER } from '../../infra/billing/billing.types';
import type {
  BillingEvent,
  SubscriptionBillingProvider,
  WebhookHeaders,
} from '../../infra/billing/billing.types';
import type {
  SubscriptionCheckoutRow,
  SubscriptionPaymentDisposition,
} from '../../infra/database/schema/subscription-billing';
import { SubscriptionPeriodAlreadyQueuedError } from '../subscriptions/subscriptions.errors';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BillingRepository } from './billing.repository';

/** What the controller answers. */
export type WebhookOutcome = 'not_found' | 'invalid' | 'received';

const FAILURE_REASON = 'The billing provider reported a failed payment.';
const REFUND_REASON = 'The billing provider reported a refund. The period was left as it was.';

/**
 * The reference a payment is recorded under in `subscription_events`, which
 * is unique there: one provider checkout buys one period, however many
 * events say so. Under 200 characters, which that column's CHECK requires —
 * a provider name is at most 32 and a reference at most 160.
 */
export function paymentRefOf(provider: string, providerRef: string): string {
  return `${provider}:${providerRef}`;
}

/**
 * `POST /webhooks/billing/:provider` (issue #323): a verified provider event,
 * and nothing else, changes a subscription.
 *
 * 1. **Verify first.** The signature is checked against the raw bytes before
 *    anything is read from them, and before any database read: a forgery
 *    costs one HMAC.
 * 2. **Once per event.** A replayed event id is a no-op. Recording is
 *    `INSERT … ON CONFLICT DO NOTHING` on `(provider, provider_event_id)`, so
 *    two deliveries racing leave one row; and a success activates through
 *    `activatePeriod`, which is idempotent on the payment reference under the
 *    master's lock (#322), so they extend the period once.
 * 3. **Answer after commit.** Every write has committed when this returns,
 *    so a 2xx means it is on record, and anything that throws is a 5xx the
 *    provider retries.
 *
 * **A success is checked against its checkout** before it buys anything: the
 * amount and currency the provider says were paid must be what the checkout
 * asked. A mismatch activates nothing and is logged for a person — ADR-0046's
 * "a client cannot influence the amount charged" holds even if someone found
 * a way to pay a different amount on the hosted page.
 *
 * Never logs the body, a card fragment or a provider secret: an error line
 * names the provider, the event kind and our own checkout id.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly subscriptions: SubscriptionsService,
    @Inject(BILLING_PROVIDER) private readonly provider: SubscriptionBillingProvider,
  ) {}

  async apply(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: WebhookHeaders,
  ): Promise<WebhookOutcome> {
    if (providerName !== this.provider.name) {
      return 'not_found';
    }
    if (rawBody === undefined) {
      return 'invalid';
    }

    const verification = this.provider.verifyWebhook(rawBody, headers);
    if (verification.outcome !== 'verified') {
      return verification.outcome === 'invalid' ? 'invalid' : 'received';
    }

    const { event } = verification;
    const provider = this.provider.name;
    if (await this.repository.hasPaymentEvent(provider, event.eventId)) {
      return 'received';
    }

    const checkout = await this.repository.findCheckoutByRef(provider, event.providerRef);
    if (checkout === undefined) {
      this.logger.error(
        `Billing webhook: a verified ${event.kind} event from "${provider}" names no checkout we opened. Recorded; nothing changed.`,
      );
      await this.record(event, null, 'unknown_checkout');
      return 'received';
    }

    if (event.kind === 'succeeded') {
      await this.applySuccess(event, checkout);
    } else {
      await this.applyOther(event, checkout);
    }
    return 'received';
  }

  private async applySuccess(
    event: Extract<BillingEvent, { kind: 'succeeded' }>,
    checkout: SubscriptionCheckoutRow,
  ): Promise<void> {
    if (event.amountMinor !== checkout.amountMinor || event.currency !== checkout.currency) {
      this.logger.error(
        `Billing webhook: checkout ${checkout.id} was paid a different amount or currency than it asked. ` +
          'Recorded; no period was activated. A person must resolve it.',
      );
      await this.record(event, checkout.id, 'amount_mismatch');
      return;
    }

    const paymentRef = paymentRefOf(checkout.provider, checkout.providerRef);
    let disposition: SubscriptionPaymentDisposition = 'activated';
    if (await this.subscriptions.hasActivated(paymentRef)) {
      disposition = 'already_applied';
    } else {
      try {
        // Against the price version the checkout recorded, not the current
        // one: a price change since does not change what this payment buys.
        await this.subscriptions.activatePeriod({
          masterId: checkout.masterId,
          billingPeriod: checkout.billingPeriod,
          priceId: checkout.priceId,
          paymentRef,
        });
      } catch (error) {
        if (!(error instanceof SubscriptionPeriodAlreadyQueuedError)) {
          throw error;
        }
        // Two checkouts paid while one period was running: prepaid stacking
        // holds one queued period, so the second payment bought nothing.
        this.logger.error(
          `Billing webhook: checkout ${checkout.id} was paid while a bought period was already queued. ` +
            'Recorded; no period was activated. The payment needs a refund or a grant.',
        );
        disposition = 'period_already_queued';
      }
    }
    await this.record(event, checkout.id, disposition);

    // The card is kept only when the master asked for auto-renewal on this
    // very page (ADR-0058), and only for a payment that bought its period.
    if (
      disposition !== 'period_already_queued' &&
      checkout.kind === 'hosted' &&
      checkout.saveCard &&
      event.savedCardToken !== undefined
    ) {
      await this.repository.savePaymentMethod({
        masterId: checkout.masterId,
        provider: checkout.provider,
        tokenRef: event.savedCardToken,
        now: new Date(),
      });
    }

    // **The latest purchase decides** (#424). A master who pays by hand with
    // auto-renewal unticked has said not to charge their card again, even if
    // a card was saved on an earlier purchase; leaving that card live would
    // charge the next period against the choice they made last.
    if (disposition === 'activated' && checkout.kind === 'hosted' && !checkout.saveCard) {
      await this.repository.revokePaymentMethod(checkout.masterId, new Date());
    }
  }

  /** A failure or a refund: the provider event and the subscription event commit together. */
  private async applyOther(
    event: Extract<BillingEvent, { kind: 'failed' | 'refunded' }>,
    checkout: SubscriptionCheckoutRow,
  ): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const inserted = await this.repository.insertPayment(tx, {
        ...this.paymentColumns(event),
        checkoutId: checkout.id,
        disposition: 'recorded',
      });
      if (!inserted) {
        return;
      }
      await this.subscriptions.recordPaymentEvent(tx, {
        masterId: checkout.masterId,
        kind: event.kind === 'failed' ? 'payment_failed' : 'payment_refunded',
        billingPeriod: checkout.billingPeriod,
        reason: event.kind === 'failed' ? FAILURE_REASON : REFUND_REASON,
      });
    });
  }

  private async record(
    event: BillingEvent,
    checkoutId: string | null,
    disposition: SubscriptionPaymentDisposition,
  ): Promise<void> {
    await this.repository.transaction((tx) =>
      this.repository.insertPayment(tx, {
        ...this.paymentColumns(event),
        checkoutId,
        disposition,
      }),
    );
  }

  private paymentColumns(event: BillingEvent) {
    return {
      provider: this.provider.name,
      providerEventId: event.eventId,
      providerRef: event.providerRef,
      kind: event.kind,
      amountMinor: event.kind === 'failed' ? null : event.amountMinor,
      currency: event.kind === 'failed' ? null : event.currency,
      occurredAt: event.occurredAt,
    };
  }
}
