import type { OrderReviews, OrderStatus, Review } from '@tezusta/types';

/**
 * The statuses a review can be written in (ADR-0042 § 2): `COMPLETED` and
 * everything after it. A dispute neither blocks nor removes a review.
 *
 * Restated from the server's rule for one reason only — **not to ask**. The
 * order screen reads an order's reviews only once the order could have any, so
 * a customer watching a master on the way costs no review request at all.
 * Whether a review is actually accepted is still the server's answer
 * (`canReview`), never this set's.
 */
const REVIEWABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
]);

export function isReviewableStatus(status: OrderStatus): boolean {
  return REVIEWABLE_STATUSES.has(status);
}

/**
 * Whether the prompt card is shown (ADR-0042 § 1): the reader may still review
 * and has not. Read defensively — a body that is not the contract (a proxy's
 * page, an empty object) prompts nothing rather than something wrong.
 */
export function shouldPromptReview(reviews: OrderReviews | undefined): boolean {
  return reviews?.canReview === true && reviews.mine === null;
}

/** Which of the review screen's modes the server's answer puts it in. */
export type ReviewScreenMode =
  | { readonly kind: 'write' }
  | { readonly kind: 'edit'; readonly review: Review }
  | {
      readonly kind: 'read';
      readonly review: Review;
      readonly why: 'revealed' | 'removed' | 'closed';
    }
  | { readonly kind: 'unavailable'; readonly why: 'not-yet' | 'closed' };

/**
 * The review screen's mode, decided from `GET /orders/:id/reviews` alone.
 *
 * `canReview` and `canEdit` are the server's hints and the only thing that
 * turns on an input — a review the server says is frozen is shown read-only
 * even if the clock on this phone disagrees. Read-only is then explained by
 * the review itself: removed (ADR-0042 § 7), revealed (§ 4), or still sealed
 * with the window shut, waiting for the sweep that reveals it (§ 3).
 */
export function reviewScreenMode(reviews: OrderReviews): ReviewScreenMode {
  const { mine } = reviews;

  if (mine === null) {
    if (reviews.canReview) {
      return { kind: 'write' };
    }
    return { kind: 'unavailable', why: reviews.windowClosesAt === null ? 'not-yet' : 'closed' };
  }

  if (reviews.canEdit && mine.revealedAt === null && mine.removedAt === null) {
    return { kind: 'edit', review: mine };
  }

  const why =
    mine.removedAt !== null ? 'removed' : mine.revealedAt !== null ? 'revealed' : 'closed';
  return { kind: 'read', review: mine, why };
}
