import { Injectable } from '@nestjs/common';
import type { AdminReview, CursorPage, RatingRecalculation } from '@tezusta/types';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { ReviewsAdminService } from '../reviews/reviews-admin.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type {
  ListAdminReviewsQuery,
  RecalculateRatingsBody,
  RemoveReviewBody,
} from './admin-reviews.schema';

/**
 * Admin actions on reviews, each one audited (user-roles invariant 6).
 */
@Injectable()
export class AdminReviewsService {
  constructor(
    private readonly reviews: ReviewsAdminService,
    private readonly admins: AdminRepository,
  ) {}

  /**
   * Recalculates and records who did it (#223).
   *
   * **The audit target is the profile, or a fresh run id for "everybody".**
   * `admin_audit_log.target_id` is a non-null uuid, and a platform-wide run
   * has no natural row to point at; a uuidv7 minted per run gives it one, and
   * its time prefix orders runs the way they happened. Written after the
   * recalculation, the ordering `AdminOrdersService` uses: a correction whose
   * audit write then failed is loud, and an audit row for a correction that
   * never happened would be a lie.
   */
  async recalculate(admin: AdminActor, body: RecalculateRatingsBody): Promise<RatingRecalculation> {
    const result = await this.reviews.recalculate(body);

    const target =
      body.masterId !== undefined
        ? { targetType: 'master', targetId: body.masterId }
        : body.customerId !== undefined
          ? { targetType: 'customer', targetId: body.customerId }
          : { targetType: 'rating_recalculation', targetId: uuidV7() };

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'rating.recalculate',
      ...target,
    });

    return result;
  }

  /**
   * The moderation listing (#224). Not audited per read: it is the admin's
   * working view of reviews already scoped to an order or a profile, not a
   * read of anybody's personal data beyond what a review holds.
   */
  async list(query: ListAdminReviewsQuery): Promise<CursorPage<AdminReview>> {
    return this.reviews.list(query);
  }

  /**
   * Removes a review with its reason, the aggregate correction and the audit
   * row in **one transaction** (ADR-0042 § 7, user-roles invariant 6). A
   * removal that committed without its audit row would be a moderation
   * decision nobody can account for.
   */
  async remove(admin: AdminActor, reviewId: string, body: RemoveReviewBody): Promise<AdminReview> {
    return this.reviews.remove({
      reviewId,
      adminId: admin.adminUserId,
      reason: body.reason,
      record: (tx) =>
        this.admins.appendAudit(
          {
            adminUserId: admin.adminUserId,
            action: 'review.remove',
            targetType: 'review',
            targetId: reviewId,
            reason: body.reason,
          },
          new Date(),
          tx,
        ),
    });
  }
}
