import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
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
 */
@Module({
  imports: [DatabaseModule, CustomersModule, MastersModule],
  controllers: [ReviewsController],
  providers: [ReviewsRepository, ReviewsService],
})
export class ReviewsModule {}
