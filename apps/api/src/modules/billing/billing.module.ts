import { Module } from '@nestjs/common';

import { CLOCK, systemClock } from '../../common/time/clock';
import { BillingInfraModule } from '../../infra/billing/billing.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { MastersModule } from '../masters/masters.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { BillingRawBodyHook } from './billing-raw-body.hook';
import { BillingReconciler } from './billing-reconciler.service';
import { BillingRepository } from './billing.repository';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { SubscriptionCheckoutController } from './subscription-checkout.controller';
import { SubscriptionCheckoutService } from './subscription-checkout.service';

/**
 * Subscription billing (issue #323, ADR-0057): the checkout a master opens,
 * the provider webhook that alone extends a period, and the reconciliation
 * that notices when the two stop agreeing.
 *
 * A module of its own rather than part of `SubscriptionsModule`, which
 * imports no domain module (`subscriptions.module.ts`): the checkout has to
 * resolve the calling master, which is `MastersModule`'s question. The arrow
 * points one way — billing depends on subscriptions and masters, and neither
 * learns that billing exists. `SubscriptionsService.activatePeriod` stays the
 * only writer of a period.
 */
@Module({
  imports: [DatabaseModule, QueueModule, BillingInfraModule, MastersModule, SubscriptionsModule],
  controllers: [SubscriptionCheckoutController, BillingWebhookController],
  providers: [
    BillingRepository,
    SubscriptionCheckoutService,
    BillingWebhookService,
    BillingReconciler,
    BillingRawBodyHook,
    { provide: CLOCK, useValue: systemClock },
  ],
})
export class BillingModule {}
