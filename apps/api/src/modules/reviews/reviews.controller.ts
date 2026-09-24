import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { OrderReviews, Review } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { reviewOrderIdParamsSchema, submitReviewSchema } from './reviews.schema';
import { ReviewsService } from './reviews.service';

class ReviewOrderIdParamsDto extends createZodDto(reviewOrderIdParamsSchema) {}
class SubmitReviewDto extends createZodDto(submitReviewSchema) {}

/**
 * The reviews on one order (issue #222,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **Routes under `orders/:orderId`, and no review id in any of them.** A party
 * has at most one review per order, so `review` (singular) names the caller's
 * own and `reviews` names what the caller may see of both — there is no
 * second identifier space for authorization to be got wrong in. The author's
 * side is never sent: the server derives it from who is asking.
 *
 * `@Roles('customer', 'master')` is a cheap first gate and not the
 * authorization — whether this caller is this order's customer or its master
 * is re-read from the database on every request (`reviews.service.ts`).
 *
 * **`POST` and `PUT` share one budget** (ADR-0042 § 9): ten per user per hour,
 * several times what an honest user produces, and what bounds both the edit
 * path and scripted probing of order ids. The read is not limited, for the
 * reason `conversations.controller.ts` gives for its reads: it returns only
 * what the caller is already party to.
 */
@Roles('customer', 'master')
@Controller('orders/:orderId')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** What the caller may see of both reviews, and whether they may still write. */
  @Get('reviews')
  async list(
    @CurrentActor() actor: Actor,
    @Param() params: ReviewOrderIdParamsDto,
  ): Promise<OrderReviews> {
    return this.reviews.getForOrder(actor, params.orderId);
  }

  /** Writes the caller's review; sealed unless it is the second, which reveals both. */
  @RateLimit({ policy: 'review-submit', identifier: rateLimitByUser })
  @Post('review')
  async submit(
    @CurrentActor() actor: Actor,
    @Param() params: ReviewOrderIdParamsDto,
    @Body() body: SubmitReviewDto,
  ): Promise<Review> {
    return this.reviews.submit(actor, params.orderId, body);
  }

  /** Replaces the caller's review while it is still sealed. The body is the whole review. */
  @RateLimit({ policy: 'review-submit', identifier: rateLimitByUser })
  @Put('review')
  async edit(
    @CurrentActor() actor: Actor,
    @Param() params: ReviewOrderIdParamsDto,
    @Body() body: SubmitReviewDto,
  ): Promise<Review> {
    return this.reviews.edit(actor, params.orderId, body);
  }
}
