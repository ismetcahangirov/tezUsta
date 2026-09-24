import { Injectable } from '@nestjs/common';
import type { RatingRecalculation, RecalculateRatingsRequest } from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import { ReviewsRepository } from './reviews.repository';

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
