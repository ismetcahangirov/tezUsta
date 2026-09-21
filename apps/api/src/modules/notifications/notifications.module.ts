import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { PushModule } from '../../infra/push/push.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { DevicesModule } from '../devices/devices.module';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationsService } from './notifications.service';
import { PushTicketsRepository } from './push-tickets.repository';

/**
 * Push notifications (EPIC 10, issue #141).
 *
 * Both halves of the mechanism live here and only one of them is exported:
 * `NotificationsService` is what issue #144 calls from the order and dispatch
 * paths, while `NotificationDeliveryService` registers itself with the queue's
 * handler registry and is nobody's dependency. A module that could reach the
 * delivery service could send inline from a request, which is the one thing
 * this Epic exists to prevent.
 *
 * It imports `DevicesModule` rather than reading `devices` itself — "which
 * phones does this user have?" is a question that module owns
 * (`backend-architecture.md` § Module rules).
 */
@Module({
  imports: [DatabaseModule, QueueModule, PushModule, DevicesModule],
  providers: [NotificationsService, NotificationDeliveryService, PushTicketsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
