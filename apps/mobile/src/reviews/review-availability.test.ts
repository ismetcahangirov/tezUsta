import type { OrderReviews, OrderStatus, Review } from '@tezusta/types';

import { isReviewableStatus, reviewScreenMode, shouldPromptReview } from './review-availability';

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    orderId: 'order-1',
    authorRole: 'customer',
    rating: 4,
    comment: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    revealedAt: null,
    removedAt: null,
    ...overrides,
  };
}

function reviews(overrides: Partial<OrderReviews> = {}): OrderReviews {
  return {
    orderId: 'order-1',
    role: 'customer',
    mine: null,
    theirs: null,
    windowClosesAt: '2026-09-27T10:00:00.000Z',
    canReview: true,
    canEdit: false,
    ...overrides,
  };
}

describe('isReviewableStatus (ADR-0042 § 2)', () => {
  it.each<OrderStatus>([
    'COMPLETED',
    'PAYMENT_PENDING',
    'PAID',
    'DISPUTED',
    'RESOLVED',
    'REFUNDED',
  ])('%s is completed or later', (status) => {
    expect(isReviewableStatus(status)).toBe(true);
  });

  it.each<OrderStatus>([
    'SEARCHING',
    'ACCEPTED',
    'MASTER_ON_THE_WAY',
    'MASTER_ARRIVED',
    'IN_PROGRESS',
    'CANCELLED',
    'NO_MASTER_FOUND',
  ])('%s is not', (status) => {
    expect(isReviewableStatus(status)).toBe(false);
  });
});

describe('shouldPromptReview (ADR-0042 § 1)', () => {
  it('prompts while the reader may review and has not', () => {
    expect(shouldPromptReview(reviews())).toBe(true);
  });

  it('stops prompting once the reader has written a review', () => {
    expect(shouldPromptReview(reviews({ mine: review(), canReview: false, canEdit: true }))).toBe(
      false,
    );
  });

  it('does not prompt once the window has closed', () => {
    expect(shouldPromptReview(reviews({ canReview: false }))).toBe(false);
  });

  it('prompts nothing for an answer it has not got, or one that is not the contract', () => {
    expect(shouldPromptReview(undefined)).toBe(false);
    expect(shouldPromptReview({} as OrderReviews)).toBe(false);
  });
});

describe('reviewScreenMode', () => {
  it('writes a first review while the server accepts one', () => {
    expect(reviewScreenMode(reviews())).toEqual({ kind: 'write' });
  });

  it('edits the reader’s review while it is sealed', () => {
    const mine = review();
    expect(reviewScreenMode(reviews({ mine, canReview: false, canEdit: true }))).toEqual({
      kind: 'edit',
      review: mine,
    });
  });

  it('is read-only once the review is revealed', () => {
    const mine = review({ revealedAt: '2026-09-21T10:00:00.000Z' });
    expect(reviewScreenMode(reviews({ mine, canReview: false, canEdit: false }))).toEqual({
      kind: 'read',
      review: mine,
      why: 'revealed',
    });
  });

  it('is read-only, and says so, once an admin removed it', () => {
    const mine = review({
      revealedAt: '2026-09-21T10:00:00.000Z',
      removedAt: '2026-09-22T10:00:00.000Z',
    });
    expect(reviewScreenMode(reviews({ mine, canReview: false }))).toMatchObject({
      kind: 'read',
      why: 'removed',
    });
  });

  it('is read-only when sealed but the window has shut, waiting to be revealed', () => {
    expect(reviewScreenMode(reviews({ mine: review(), canReview: false }))).toMatchObject({
      kind: 'read',
      why: 'closed',
    });
  });

  it('trusts the server over the review: no edit without canEdit', () => {
    expect(reviewScreenMode(reviews({ mine: review(), canEdit: false }))).toMatchObject({
      kind: 'read',
    });
  });

  it('has nothing to write before the order completes, or after the window', () => {
    expect(reviewScreenMode(reviews({ canReview: false, windowClosesAt: null }))).toEqual({
      kind: 'unavailable',
      why: 'not-yet',
    });
    expect(reviewScreenMode(reviews({ canReview: false }))).toEqual({
      kind: 'unavailable',
      why: 'closed',
    });
  });
});
