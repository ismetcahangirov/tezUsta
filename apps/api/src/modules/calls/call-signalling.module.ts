import { Module } from '@nestjs/common';

import { CallsModule } from '../../infra/calls/calls.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { CallEventsRegistry } from './call-events.registry';
import { CallsController } from './calls.controller';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';

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
  controllers: [CallsController],
  providers: [CallsRepository, CallsService, CallEventsRegistry],
  exports: [CallsService, CallEventsRegistry],
})
export class CallSignallingModule {}
