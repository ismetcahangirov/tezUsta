import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AdminReview, CursorPage, RatingRecalculation } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import {
  adminReviewIdParamsSchema,
  listAdminReviewsQuerySchema,
  recalculateRatingsSchema,
  removeReviewSchema,
} from './admin-reviews.schema';
import { AdminReviewsService } from './admin-reviews.service';
import type { AdminActor } from './admin.types';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class RecalculateRatingsDto extends createZodDto(recalculateRatingsSchema) {}
class ListAdminReviewsQueryDto extends createZodDto(listAdminReviewsQuerySchema) {}
class AdminReviewIdParamsDto extends createZodDto(adminReviewIdParamsSchema) {}
class RemoveReviewDto extends createZodDto(removeReviewSchema) {}

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
  @RequireAdminPermission('reviews.moderate')
  @HttpCode(200)
  @Post('ratings/recalculate')
  async recalculate(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: RecalculateRatingsDto,
  ): Promise<RatingRecalculation> {
    return this.reviews.recalculate(admin, body);
  }

  /** Every review matching the filters, removed ones and their reasons included (#224). */
  @RequireAdminPermission('reviews.moderate')
  @Get('reviews')
  async list(@Query() query: ListAdminReviewsQueryDto): Promise<CursorPage<AdminReview>> {
    return this.reviews.list(query);
  }

  /**
   * Removes a review with a mandatory reason (ADR-0042 § 7, #224). `POST` to a
   * `removal` sub-resource rather than `DELETE`, because nothing is deleted:
   * the row stays, marked, with who removed it and why. 200, not 201 — the
   * removal is a state of the review, not a new resource with its own id.
   */
  @RequireAdminPermission('reviews.moderate')
  @HttpCode(200)
  @Post('reviews/:reviewId/removal')
  async remove(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminReviewIdParamsDto,
    @Body() body: RemoveReviewDto,
  ): Promise<AdminReview> {
    return this.reviews.remove(admin, params.reviewId, body);
  }
}
