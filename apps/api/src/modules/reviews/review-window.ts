import type { OrderStatus } from '@tezusta/types';

/**
 * The statuses in which an order may be reviewed — everything "`COMPLETED` or
 * later" means in `docs/product/user-roles.md`
 * ([ADR-0042](docs/decisions/ADR-0042-review-policy.md) § 2).
 *
 * **A positive list**, for the reason `CONVERSATION_WRITABLE_STATUSES` is one:
 * a status added to ADR-0015 later defaults to *not reviewable* rather than
 * silently becoming a state in which a review can be left on an order that
 * never finished. `DISPUTED` is on it deliberately — a dispute is about money
 * and a review is an opinion, and a customer in a dispute is exactly the
 * customer whose opinion other customers want.
 */
export const REVIEWABLE_ORDER_STATUSES = [
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
] as const satisfies readonly OrderStatus[];

export function isReviewableStatus(status: OrderStatus): boolean {
  return (REVIEWABLE_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

const HOUR_MS = 3_600_000;

/**
 * When the review window closes: `windowHours` after the order **entered**
 * `COMPLETED`, read from `order_status_history` rather than from the order's
 * current status timestamp — so a later move to `PAYMENT_PENDING`, `PAID` or
 * `DISPUTED` neither restarts nor ends it (ADR-0042 § 2). Null when the order
 * has never been completed.
 */
export function reviewWindowClosesAt(completedAt: Date | null, windowHours: number): Date | null {
  return completedAt === null ? null : new Date(completedAt.getTime() + windowHours * HOUR_MS);
}

/**
 * Whether a review may be written or edited at `now`. **Closed at the instant
 * the window ends**, not a moment after: the reveal the window's close
 * triggers is due at that instant, and a write accepted at the boundary would
 * race it.
 */
export function isReviewWindowOpen(closesAt: Date | null, now: Date): boolean {
  return closesAt !== null && now.getTime() < closesAt.getTime();
}

/** What stands between a party and writing a review, in the order it is checked. */
export type ReviewEligibility =
  | { readonly kind: 'open'; readonly closesAt: Date }
  | { readonly kind: 'not-reviewable' }
  | { readonly kind: 'window-closed'; readonly closesAt: Date };

/**
 * The status rule and the window rule as one answer. A status that is not
 * reviewable is refused as such even if the order was once completed; a
 * reviewable status with no `COMPLETED` history row — which no legal path
 * produces — is refused as not reviewable rather than given a window from
 * nowhere.
 */
export function reviewEligibility(input: {
  readonly status: OrderStatus;
  readonly completedAt: Date | null;
  readonly windowHours: number;
  readonly now: Date;
}): ReviewEligibility {
  const closesAt = reviewWindowClosesAt(input.completedAt, input.windowHours);

  if (!isReviewableStatus(input.status) || closesAt === null) {
    return { kind: 'not-reviewable' };
  }

  return isReviewWindowOpen(closesAt, input.now)
    ? { kind: 'open', closesAt }
    : { kind: 'window-closed', closesAt };
}
