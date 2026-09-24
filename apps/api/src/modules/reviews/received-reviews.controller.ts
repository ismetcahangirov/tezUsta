import { Controller, Get, Query } from '@nestjs/common';
import type { CursorPage, Review } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { receivedReviewsQuerySchema } from './reviews.schema';
import { ReviewsService } from './reviews.service';

class ReceivedReviewsQueryDto extends createZodDto(receivedReviewsQuerySchema) {}

/**
 * The reviews written about the caller (issue #225, ADR-0042 § 6).
 *
 * Under `me/` because the subject is always the caller — there is no id in
 * the route to point at anybody else's reviews, which is the whole
 * authorization story for a read of one's own record. Not rate-limited, for
 * the reason the other review read is not: bounded pages of what the caller
 * is already entitled to see.
 */
@Roles('customer', 'master')
@Controller('me/reviews')
export class ReceivedReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Revealed, unremoved reviews about the caller in `role`, newest first. */
  @Get('received')
  async received(
    @CurrentActor() actor: Actor,
    @Query() query: ReceivedReviewsQueryDto,
  ): Promise<CursorPage<Review>> {
    return this.reviews.listReceived(actor, query);
  }
}
