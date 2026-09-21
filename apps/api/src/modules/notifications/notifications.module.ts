import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { PushModule } from '../../infra/push/push.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { DevicesModule } from '../devices/devices.module';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesRepository } from './notification-preferences.repository';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';
import { PushTicketsRepository } from './push-tickets.repository';

/**
 * Push notifications (EPIC 10, issues #141 and #143).
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
 *
 * **Preferences live here rather than in a module of their own** (#143), and
 * the reason is the direction of the arrows. The category vocabulary, the copy
 * table and the send-time filter are all in this module already; a separate
 * module would have to import this one's kinds and export a service straight
 * back into it, which is an edge that buys nothing and one refactor away from
 * being a cycle (CLAUDE.md §14's `no-circular`). `devices` draws the same line
 * for the same reason: one module, a controller for the user and a service for
 * the worker.
 */
@Module({
  imports: [DatabaseModule, QueueModule, PushModule, DevicesModule],
  controllers: [NotificationPreferencesController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    PushTicketsRepository,
    NotificationPreferencesRepository,
    NotificationPreferencesService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
