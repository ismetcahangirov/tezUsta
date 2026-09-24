import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { RatingRecalculation } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { recalculateRatingsSchema } from './admin-reviews.schema';
import { AdminReviewsService } from './admin-reviews.service';
import type { AdminActor } from './admin.types';
import { CurrentAdmin } from './current-admin.decorator';

class RecalculateRatingsDto extends createZodDto(recalculateRatingsSchema) {}

/**
 * Admin operations on reviews and ratings (EPIC 11, issues #223 and #224).
 *
 * Guarded by its `/admin` path, like every admin controller: the global admin
 * authentication guard refuses a consumer token on anything under it
 * (`admin-verification.e2e.test.ts` walks the route table to prove it).
 */
@Controller('admin')
export class AdminReviewsController {
  constructor(private readonly reviews: AdminReviewsService) {}

  /**
   * Recomputes rating aggregates from the reviews (ADR-0042 § 6, #223). The
   * repair path, never a read path. `@HttpCode(200)` because nothing is
   * created: stored numbers are corrected in place.
   */
  @HttpCode(200)
  @Post('ratings/recalculate')
  async recalculate(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: RecalculateRatingsDto,
  ): Promise<RatingRecalculation> {
    return this.reviews.recalculate(admin, body);
  }
}
