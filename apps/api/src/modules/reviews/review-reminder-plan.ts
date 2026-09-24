import type { OrderStatus, ReviewAuthorRole } from '@tezusta/types';

import { reviewEligibility } from './review-window';

const SIDES: readonly ReviewAuthorRole[] = ['customer', 'master'];

/**
 * Which parties the reminder job should tell (ADR-0042 § 1, issue #226): every
 * side that has not reviewed, provided the order can still be reviewed at all.
 *
 * Nothing is owed on an order that is no longer reviewable or whose window has
 * closed — a reminder to do something the API would refuse is worse than none.
 */
export function planReviewReminders(input: {
  readonly status: OrderStatus;
  readonly completedAt: Date | null;
  readonly windowHours: number;
  readonly now: Date;
  readonly reviewedBy: readonly ReviewAuthorRole[];
}): ReviewAuthorRole[] {
  const eligibility = reviewEligibility(input);
  if (eligibility.kind !== 'open') {
    return [];
  }
  return SIDES.filter((side) => !input.reviewedBy.includes(side));
}
