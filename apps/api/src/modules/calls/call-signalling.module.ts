import { Module } from '@nestjs/common';

import { CallsModule } from '../../infra/calls/calls.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { CallEventsRegistry } from './call-events.registry';
import { CallHistoryController } from './call-history.controller';
import { CallMediaWebhookController } from './call-media-webhook.controller';
import { CallReconciliationService } from './call-reconciliation.service';
import { CallRecordsService } from './call-records.service';
import { CallRingRegistry } from './call-ring.registry';
import { CallsController } from './calls.controller';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';
import { WebhookBodyParser } from './webhook-body.parser';

/**
 * The ring/answer state machine and the `calls` table (issue #185).
 *
 * **Named for signalling, not "calls"**, because `infra/calls/CallsModule` is
 * already the media server port (#184): that one knows what a room and a token
 * are, this one knows what a call between two parties to an order is, and it
 * is the only consumer of the other.
 *
 * **It does not import `modules/realtime`, and that is the design.** The
 * gateway receives the inbound frames and calls {@link CallsService}; the
 * outbound frames leave through {@link CallEventsRegistry}, a slot the realtime
 * module fills. So the arrow points realtime → calls → orders, and nothing
 * points back (CLAUDE.md §14).
 *
 * #186 adds the other half of a call's life: the records (`GET
 * /orders/:orderId/calls`, and `CallRecordsService` for the admin list, which
 * `AdminModule` imports this module for), and the reconciliation of live calls
 * against the media server — the LiveKit webhook and the reaper, both in
 * `CallReconciliationService`.
 */
@Module({
  imports: [
    DatabaseModule,
    CallsModule,
    QueueModule,
    RateLimitModule,
    OrdersModule,
    CustomersModule,
    MastersModule,
  ],
  controllers: [CallsController, CallHistoryController, CallMediaWebhookController],
  providers: [
    CallsRepository,
    CallsService,
    CallEventsRegistry,
    CallRingRegistry,
    CallRecordsService,
    CallReconciliationService,
    WebhookBodyParser,
  ],
  // `CallRingRegistry` for `modules/notifications`, which fills it and reads
  // `CallsService.isRingingFor` back (#189) — the arrow points notifications →
  // calls, and nothing here imports that module.
  exports: [CallsService, CallEventsRegistry, CallRingRegistry, CallRecordsService],
})
export class CallSignallingModule {}
