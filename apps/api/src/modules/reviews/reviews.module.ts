import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { ReceivedReviewsController } from './received-reviews.controller';
import { ReviewRevealService } from './review-reveal.service';
import { ReviewTimersService } from './review-timers.service';
import { ReviewsAdminService } from './reviews-admin.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsRepository } from './reviews.repository';
import { ReviewsService } from './reviews.service';

/**
 * Reviews and ratings (EPIC 11, issue #222,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **Its own module rather than a corner of `OrdersModule`**, although a review
 * hangs off an order the way a conversation does. The conversation had to live
 * in `OrdersModule` because the order's own transitions open and close it;
 * nothing about an order's lifecycle touches a review — the window is read
 * from the order's trail, and the reveal is driven by the second submission
 * (and, later, by the window closing). So the arrow points one way, reviews →
 * orders' tables, and the module does not import `OrdersModule` at all.
 *
 * `CustomersModule` and `MastersModule` answer "which profile is this actor?";
 * the order row itself is read inside the review's own transaction, under the
 * lock that makes the checks hold (`reviews.repository.ts`).
 *
 * #226 adds the timers a completed order starts (`review-timers.service.ts`):
 * `OrdersModule` only for `OrderNotificationsRegistry`, the slot every
 * transition is announced through, `QueueModule` for the deferred jobs, and
 * `NotificationsModule` to hand the reminder to the delivery pipeline. None of
 * the three imports this module, so every arrow still points one way.
 */
@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    CustomersModule,
    MastersModule,
    OrdersModule,
    NotificationsModule,
  ],
  controllers: [ReviewsController, ReceivedReviewsController],
  providers: [
    ReviewsRepository,
    ReviewsService,
    ReviewTimersService,
    ReviewRevealService,
    ReviewsAdminService,
  ],
  // For `AdminModule` (#223, #224), which guards, audits and routes the admin
  // operations; nothing here imports it back.
  exports: [ReviewsAdminService],
})
export class ReviewsModule {}
