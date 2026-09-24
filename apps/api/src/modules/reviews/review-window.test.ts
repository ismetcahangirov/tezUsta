import type { OrderStatus } from '@tezusta/types';
import { describe, expect, it } from 'vitest';

import {
  isReviewableStatus,
  isReviewWindowOpen,
  REVIEWABLE_ORDER_STATUSES,
  reviewEligibility,
  reviewWindowClosesAt,
} from './review-window';

const ALL_STATUSES: readonly OrderStatus[] = [
  'DRAFT',
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
  'NO_MASTER_FOUND',
  'CANCELLED',
];

const WEEK_HOURS = 168;
const completedAt = new Date('2026-09-20T10:00:00.000Z');
const closesAt = new Date('2026-09-27T10:00:00.000Z');

describe('which order statuses may be reviewed (ADR-0042 § 2)', () => {
  it.each(['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'DISPUTED', 'RESOLVED', 'REFUNDED'] as const)(
    '%s is reviewable',
    (status) => {
      expect(isReviewableStatus(status)).toBe(true);
    },
  );

  it.each(
    ALL_STATUSES.filter(
      (status) => !(REVIEWABLE_ORDER_STATUSES as readonly OrderStatus[]).includes(status),
    ),
  )('%s is not', (status) => {
    expect(isReviewableStatus(status)).toBe(false);
  });

  it('names exactly six statuses, so a new one defaults to not reviewable', () => {
    expect(REVIEWABLE_ORDER_STATUSES).toHaveLength(6);
  });
});

describe('the review window', () => {
  it('closes the configured number of hours after the order entered COMPLETED', () => {
    expect(reviewWindowClosesAt(completedAt, WEEK_HOURS)).toEqual(closesAt);
    expect(reviewWindowClosesAt(completedAt, 1)).toEqual(new Date('2026-09-20T11:00:00.000Z'));
  });

  it('does not exist for an order that was never completed', () => {
    expect(reviewWindowClosesAt(null, WEEK_HOURS)).toBeNull();
    expect(isReviewWindowOpen(null, completedAt)).toBe(false);
  });

  it('is open from the moment of completion until just before it closes', () => {
    expect(isReviewWindowOpen(closesAt, completedAt)).toBe(true);
    expect(isReviewWindowOpen(closesAt, new Date(closesAt.getTime() - 1))).toBe(true);
  });

  it('is closed at the instant it ends and after', () => {
    expect(isReviewWindowOpen(closesAt, closesAt)).toBe(false);
    expect(isReviewWindowOpen(closesAt, new Date(closesAt.getTime() + 1))).toBe(false);
  });
});

describe('review eligibility', () => {
  const base = { completedAt, windowHours: WEEK_HOURS, now: new Date('2026-09-21T00:00:00Z') };

  it('is open on a completed order inside the window', () => {
    expect(reviewEligibility({ ...base, status: 'COMPLETED' })).toEqual({ kind: 'open', closesAt });
  });

  it('keeps the window measured from completion after the order moves on', () => {
    expect(reviewEligibility({ ...base, status: 'DISPUTED' })).toEqual({ kind: 'open', closesAt });
    expect(
      reviewEligibility({ ...base, status: 'PAID', now: new Date('2026-09-28T00:00:00Z') }),
    ).toEqual({ kind: 'window-closed', closesAt });
  });

  it('refuses an order that is not completed, whatever its history says', () => {
    expect(reviewEligibility({ ...base, status: 'IN_PROGRESS' })).toEqual({
      kind: 'not-reviewable',
    });
    expect(reviewEligibility({ ...base, status: 'CANCELLED' })).toEqual({
      kind: 'not-reviewable',
    });
  });

  it('refuses a reviewable status that has no completion to measure from', () => {
    expect(reviewEligibility({ ...base, status: 'PAID', completedAt: null })).toEqual({
      kind: 'not-reviewable',
    });
  });
});
