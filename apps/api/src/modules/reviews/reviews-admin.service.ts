import { Injectable } from '@nestjs/common';
import type {
  AdminReview,
  CursorPage,
  RatingRecalculation,
  RecalculateRatingsRequest,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { Transaction } from '../../infra/database/database.types';
import type { ReviewRow } from '../../infra/database/schema/reviews';
import { decodeReviewCursor, encodeReviewCursor } from './review-cursor';
import { ReviewsRepository } from './reviews.repository';

/** A second removal of the same review (#224). */
export class ReviewAlreadyRemovedError extends AppError {
  constructor() {
    super(ERROR_CODES.REVIEW_ALREADY_REMOVED, 'This review has already been removed.', 409);
    this.name = 'ReviewAlreadyRemovedError';
    Object.setPrototypeOf(this, ReviewAlreadyRemovedError.prototype);
  }
}

/**
 * The reviews operations an admin drives (issue #223, and #224 after it).
 *
 * **No actor and no audit here, on purpose.** This service is exported for
 * `AdminModule`, whose guard has already proven an admin session and whose
 * service writes the `admin_audit_log` row — the same split `CallRecordsService`
 * and `AdminCallsService` use. Nothing in this module can reach it from a
 * consumer route.
 */
@Injectable()
export class ReviewsAdminService {
  constructor(private readonly reviews: ReviewsRepository) {}

  /**
   * Recomputes rating aggregates from the reviews themselves (ADR-0042 § 6).
   * One master, one customer, or — with neither named — everybody. A named
   * profile that does not exist is a 404, not a silent zero.
   */
  async recalculate(input: RecalculateRatingsRequest): Promise<RatingRecalculation> {
    if (input.masterId !== undefined) {
      await this.requireProfile('master', input.masterId);
      const corrected = await this.reviews.recalculate({ kind: 'master', id: input.masterId });
      return { scope: 'master', ...toCounts(corrected) };
    }
    if (input.customerId !== undefined) {
      await this.requireProfile('customer', input.customerId);
      const corrected = await this.reviews.recalculate({ kind: 'customer', id: input.customerId });
      return { scope: 'customer', ...toCounts(corrected) };
    }
    return { scope: 'all', ...toCounts(await this.reviews.recalculate('all')) };
  }

  /** Reviews matching the filters, removed ones included, newest first (#224). */
  async list(input: {
    readonly orderId?: string | undefined;
    readonly masterId?: string | undefined;
    readonly customerId?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<CursorPage<AdminReview>> {
    const { rows, hasMore } = await this.reviews.listForAdmin({
      orderId: input.orderId,
      masterId: input.masterId,
      customerId: input.customerId,
      limit: input.limit,
      afterReviewId: decodeReviewCursor(input.cursor),
    });
    const last = rows.at(-1);
    return {
      items: rows.map(toAdminReview),
      nextCursor: hasMore && last !== undefined ? encodeReviewCursor(last.id) : null,
    };
  }

  /**
   * Removes a review with a reason (ADR-0042 § 7, #224). `record` runs inside
   * the removal's transaction — the caller's audit row commits with the
   * removal or not at all.
   */
  async remove(input: {
    readonly reviewId: string;
    readonly adminId: string;
    readonly reason: string;
    readonly record: (tx: Transaction) => Promise<void>;
  }): Promise<AdminReview> {
    const outcome = await this.reviews.remove({
      reviewId: input.reviewId,
      adminId: input.adminId,
      reason: input.reason,
      record: (tx) => input.record(tx),
    });
    switch (outcome.kind) {
      case 'removed':
        return toAdminReview(outcome.review);
      case 'missing':
        throw new NotFoundError();
      case 'already-removed':
        throw new ReviewAlreadyRemovedError();
    }
  }

  private async requireProfile(kind: 'master' | 'customer', id: string): Promise<void> {
    if (!(await this.reviews.profileExists(kind, id))) {
      throw new NotFoundError();
    }
  }
}

function toCounts(corrected: { masters: number; customers: number }): {
  mastersCorrected: number;
  customersCorrected: number;
} {
  return { mastersCorrected: corrected.masters, customersCorrected: corrected.customers };
}

function toAdminReview(row: ReviewRow): AdminReview {
  return {
    id: row.id,
    orderId: row.orderId,
    customerId: row.customerId,
    masterId: row.masterId,
    authorRole: row.authorRole,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revealedAt: row.revealedAt === null ? null : row.revealedAt.toISOString(),
    removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
    removedByAdminId: row.removedByAdminId,
    removalReason: row.removalReason,
  };
}
