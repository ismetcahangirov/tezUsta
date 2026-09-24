import { describe, expect, it } from 'vitest';

import { planReviewReminders } from './review-reminder-plan';

const completedAt = new Date('2026-09-20T10:00:00Z');
const dayLater = new Date('2026-09-21T10:00:00Z');
const base = { status: 'COMPLETED' as const, completedAt, windowHours: 168, now: dayLater };

describe('who the review reminder goes to (issue #226)', () => {
  it('reminds both parties when neither has reviewed', () => {
    expect(planReviewReminders({ ...base, reviewedBy: [] })).toEqual(['customer', 'master']);
  });

  it('skips a party who already reviewed', () => {
    expect(planReviewReminders({ ...base, reviewedBy: ['customer'] })).toEqual(['master']);
    expect(planReviewReminders({ ...base, reviewedBy: ['master'] })).toEqual(['customer']);
  });

  it('reminds nobody once both have reviewed', () => {
    expect(planReviewReminders({ ...base, reviewedBy: ['master', 'customer'] })).toEqual([]);
  });

  it('reminds nobody once the window has closed', () => {
    expect(
      planReviewReminders({ ...base, now: new Date('2026-09-28T10:00:00Z'), reviewedBy: [] }),
    ).toEqual([]);
  });

  it('still reminds on an order that moved on to payment or dispute', () => {
    expect(planReviewReminders({ ...base, status: 'DISPUTED', reviewedBy: [] })).toHaveLength(2);
  });

  it('reminds nobody on an order that is not reviewable', () => {
    expect(
      planReviewReminders({ ...base, status: 'CANCELLED', completedAt: null, reviewedBy: [] }),
    ).toEqual([]);
  });
});
