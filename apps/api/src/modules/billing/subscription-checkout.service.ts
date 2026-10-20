import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionBillingPeriod, SubscriptionCheckout } from '@tezusta/types';

import { uuidV7 } from '../../common/ids/uuid-v7';
import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import { BILLING_PROVIDER } from '../../infra/billing/billing.types';
import type { SubscriptionBillingProvider } from '../../infra/billing/billing.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { SubscriptionCheckoutRow } from '../../infra/database/schema/subscription-billing';
import type { Actor } from '../auth/auth.types';
import { MastersService } from '../masters/masters.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BillingRepository } from './billing.repository';
import { CHECKOUT_REUSE_MS } from './billing.constants';

function toView(row: SubscriptionCheckoutRow): SubscriptionCheckout {
  if (row.checkoutUrl === null) {
    // Only a renewal has no page, and a renewal is never handed to a client.
    throw new Error(`Checkout ${row.id} has no hosted page.`);
  }
  return {
    checkoutUrl: row.checkoutUrl,
    billingPeriod: row.billingPeriod,
    amountMinor: row.amountMinor,
    currency: 'AZN',
    autoRenew: row.saveCard,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Opens a hosted checkout for the calling master (issue #323, ADR-0046 § 6).
 *
 * **The amount is the server's.** The client names a billing period; the
 * price is the current version for it (`SubscriptionsService.quoteCheckout`),
 * and the checkout row records that version's id and amount. The webhook later
 * activates against the recorded id, so an admin price change in between does
 * not change what this checkout charges.
 *
 * Everything that can refuse runs **before** the provider is called — the
 * master's verification, purchases being open, a period already queued — so
 * a refused request opens nothing at the provider.
 */
@Injectable()
export class SubscriptionCheckoutService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly masters: MastersService,
    private readonly subscriptions: SubscriptionsService,
    @Inject(BILLING_PROVIDER) private readonly provider: SubscriptionBillingProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async start(
    actor: Actor,
    billingPeriod: SubscriptionBillingPeriod,
    autoRenew = false,
  ): Promise<SubscriptionCheckout> {
    const master = await this.masters.getOwn(actor);
    // ADR-0046 § 5: only a master verification has approved may buy. The
    // same check, and the same 409, as going available.
    await this.masters.assertCanAcceptWork(master.id);

    return this.repository.transaction(async (tx) => {
      await this.repository.lockCheckouts(tx, master.id);
      const quote = await this.subscriptions.quoteCheckout(master.id, billingPeriod, tx);
      const now = this.clock.now();

      const reusable = await this.repository.findReusableCheckout(tx, {
        masterId: master.id,
        billingPeriod,
        priceId: quote.priceId,
        provider: this.provider.name,
        saveCard: autoRenew,
        since: new Date(now.getTime() - CHECKOUT_REUSE_MS),
      });
      if (reusable !== undefined) {
        return toView(reusable);
      }

      // The row's id is the provider's idempotency key, so a retry of this
      // very call cannot open a second checkout there.
      const id = uuidV7();
      const session = await this.provider.createCheckout({
        masterId: master.id,
        billingPeriod,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        idempotencyKey: id,
        returnUrl: this.config.billing.returnUrl,
        saveCard: autoRenew,
      });

      // Under the lock, so a checkout the provider opened but this row never
      // recorded — a crash between the two — is a page nobody is shown. Its
      // webhook, if anyone found it, is recorded as `unknown_checkout`.
      const row = await this.repository.insertCheckout(tx, {
        id,
        masterId: master.id,
        billingPeriod,
        priceId: quote.priceId,
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        provider: this.provider.name,
        providerRef: session.providerRef,
        kind: 'hosted',
        checkoutUrl: session.checkoutUrl,
        saveCard: autoRenew,
        renewsPeriodEnd: null,
        paymentMethodId: null,
        createdAt: now,
      });
      return toView(row);
    });
  }
}
