import { describe, expect, it } from 'vitest';

import type { SubscriptionState } from './subscription-transitions';
import {
  activatePeriod,
  cancel,
  enterGrace,
  expire,
  grantPeriod,
  isEntitled,
  nextDueTransition,
  startQueuedPeriod,
  startTrial,
  SubscriptionTransitionRefused,
} from './subscription-transitions';

function baku(local: string): Date {
  return new Date(`${local}+04:00`);
}

const START = baku('2027-03-10T12:00:00');
const END = baku('2027-04-10T12:00:00');
const BEFORE_END = new Date(END.getTime() - 1);
const AFTER_END = new Date(END.getTime() + 1);
const GRACE_DAYS = 3;
const GRACE_END = baku('2027-04-13T12:00:00');

function state(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: 'active',
    billingPeriod: 'monthly',
    currentPeriodStart: START,
    currentPeriodEnd: END,
    graceEndsAt: null,
    nextBillingPeriod: null,
    cancelledAt: null,
    ...overrides,
  };
}

const trialing = (o: Partial<SubscriptionState> = {}) =>
  state({ status: 'trialing', billingPeriod: null, ...o });
const pastDue = (o: Partial<SubscriptionState> = {}) =>
  state({ status: 'past_due', graceEndsAt: GRACE_END, ...o });
const cancelled = (o: Partial<SubscriptionState> = {}) =>
  state({ status: 'cancelled', cancelledAt: START, ...o });
const expired = (o: Partial<SubscriptionState> = {}) => state({ status: 'expired', ...o });

function refusal(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof SubscriptionTransitionRefused) {
      return error.refusal;
    }
    throw error;
  }
  return undefined;
}

describe('the entitlement', () => {
  it.each([
    ['trialing', trialing()],
    ['active', state()],
    ['cancelled, before its end', cancelled()],
  ])('holds for a %s subscription before the period end', (_label, subject) => {
    expect(isEntitled(subject, BEFORE_END)).toBe(true);
  });

  it('ends exactly at the period end, not a millisecond later', () => {
    expect(isEntitled(state(), END)).toBe(false);
    expect(isEntitled(trialing(), END)).toBe(false);
    expect(isEntitled(cancelled(), END)).toBe(false);
  });

  it('holds through grace and ends exactly at the grace end', () => {
    expect(isEntitled(pastDue(), AFTER_END)).toBe(true);
    expect(isEntitled(pastDue(), new Date(GRACE_END.getTime() - 1))).toBe(true);
    expect(isEntitled(pastDue(), GRACE_END)).toBe(false);
  });

  it('never holds once expired, whatever the dates say', () => {
    expect(isEntitled(expired(), START)).toBe(false);
  });
});

describe('starting a trial', () => {
  it('runs for the configured number of days from now', () => {
    const { next, event } = startTrial(START, 14);
    expect(next).toMatchObject({
      status: 'trialing',
      billingPeriod: null,
      currentPeriodStart: START,
      currentPeriodEnd: baku('2027-03-24T12:00:00'),
    });
    expect(event).toMatchObject({ kind: 'trial_started', fromStatus: null, toStatus: 'trialing' });
  });

  it('with zero days ends as it starts, so the master is not entitled', () => {
    const { next } = startTrial(START, 0);
    expect(next.currentPeriodEnd).toEqual(START);
    expect(isEntitled(next, START)).toBe(false);
  });
});

describe('activating a paid period', () => {
  it('starts now for a master with no subscription', () => {
    const { next, event } = activatePeriod(undefined, 'monthly', START);
    expect(next).toMatchObject({
      status: 'active',
      billingPeriod: 'monthly',
      currentPeriodStart: START,
      currentPeriodEnd: END,
    });
    expect(event).toMatchObject({ kind: 'period_activated', fromStatus: null, toStatus: 'active' });
  });

  it('starts now for an expired master', () => {
    const { next, event } = activatePeriod(expired(), 'yearly', AFTER_END);
    expect(next).toMatchObject({ status: 'active', currentPeriodStart: AFTER_END });
    expect(event).toMatchObject({ kind: 'period_activated', fromStatus: 'expired' });
  });

  it('starts now for a master in grace, and clears the grace', () => {
    const now = new Date(AFTER_END.getTime() + 3_600_000);
    const { next } = activatePeriod(pastDue(), 'monthly', now);
    expect(next).toMatchObject({ status: 'active', currentPeriodStart: now, graceEndsAt: null });
  });

  it('starts now for a master who cancelled in grace', () => {
    const { next } = activatePeriod(cancelled({ graceEndsAt: GRACE_END }), 'monthly', AFTER_END);
    expect(next).toMatchObject({ status: 'active', cancelledAt: null, graceEndsAt: null });
  });

  it('queues a yearly period behind a running month, keeping the month (prepaid stacking)', () => {
    const midMonth = baku('2027-03-25T09:00:00');
    const { next, event } = activatePeriod(state(), 'yearly', midMonth);
    expect(next).toMatchObject({
      status: 'active',
      billingPeriod: 'monthly',
      currentPeriodEnd: END,
      nextBillingPeriod: 'yearly',
    });
    expect(event).toMatchObject({
      kind: 'period_queued',
      periodStart: END,
      periodEnd: baku('2028-04-10T12:00:00'),
      billingPeriod: 'yearly',
    });
  });

  it('queues behind a running trial rather than spending it', () => {
    const { next } = activatePeriod(trialing(), 'monthly', BEFORE_END);
    expect(next).toMatchObject({ status: 'trialing', nextBillingPeriod: 'monthly' });
  });

  it('un-cancels a cancelled period that is still running and queues behind it', () => {
    const { next, event } = activatePeriod(cancelled(), 'monthly', BEFORE_END);
    expect(next).toMatchObject({
      status: 'active',
      cancelledAt: null,
      nextBillingPeriod: 'monthly',
    });
    expect(event).toMatchObject({ fromStatus: 'cancelled', toStatus: 'active' });
  });

  it('refuses a second queued period', () => {
    expect(
      refusal(() => activatePeriod(state({ nextBillingPeriod: 'monthly' }), 'yearly', BEFORE_END)),
    ).toBe('period_already_queued');
  });

  it('refuses to guess on a period that is over with a queued one not yet started', () => {
    expect(() =>
      activatePeriod(state({ nextBillingPeriod: 'monthly' }), 'yearly', AFTER_END),
    ).toThrow(/sweep/);
  });
});

describe('granting days', () => {
  it('extends a running period from its end', () => {
    const { next, event } = grantPeriod(state(), 5, BEFORE_END);
    expect(next.currentPeriodEnd).toEqual(baku('2027-04-15T12:00:00'));
    expect(next.status).toBe('active');
    expect(event).toMatchObject({ kind: 'period_granted', periodStart: END });
  });

  it('extends a trial and leaves it a trial', () => {
    const { next } = grantPeriod(trialing(), 5, BEFORE_END);
    expect(next).toMatchObject({
      status: 'trialing',
      currentPeriodEnd: baku('2027-04-15T12:00:00'),
    });
  });

  it('starts now for an expired master and keeps the billing period last bought', () => {
    const { next } = grantPeriod(expired({ billingPeriod: 'yearly' }), 30, AFTER_END);
    expect(next).toMatchObject({
      status: 'active',
      billingPeriod: 'yearly',
      currentPeriodStart: AFTER_END,
    });
  });

  it('starts now for a master with no subscription, with no billing period', () => {
    const { next } = grantPeriod(undefined, 7, START);
    expect(next).toMatchObject({ status: 'active', billingPeriod: null });
  });

  it.each([0, -1, 1.5, 367])('refuses %s days', (days) => {
    expect(() => grantPeriod(state(), days, START)).toThrow(RangeError);
  });
});

describe('cancelling', () => {
  it('lets an active period run to its end and stops it renewing', () => {
    const { next, event } = cancel(state(), BEFORE_END);
    expect(next).toMatchObject({
      status: 'cancelled',
      cancelledAt: BEFORE_END,
      currentPeriodEnd: END,
    });
    expect(isEntitled(next, BEFORE_END)).toBe(true);
    expect(event).toMatchObject({ kind: 'cancelled', fromStatus: 'active', toStatus: 'cancelled' });
  });

  it('keeps the grace of a master who cancels in grace', () => {
    const { next } = cancel(pastDue(), AFTER_END);
    expect(next).toMatchObject({ status: 'cancelled', graceEndsAt: GRACE_END });
    expect(isEntitled(next, AFTER_END)).toBe(true);
  });

  it.each([
    ['no subscription', undefined, 'nothing_to_cancel'],
    ['an expired one', expired(), 'nothing_to_cancel'],
    ['a trial', trialing(), 'trial_does_not_renew'],
    ['one already cancelled', cancelled(), 'already_cancelled'],
  ] as const)('refuses %s', (_label, subject, expected) => {
    expect(refusal(() => cancel(subject, BEFORE_END))).toBe(expected);
  });
});

describe('the sweep steps', () => {
  describe('starting a queued period', () => {
    it('starts it exactly where the old period ended', () => {
      const transition = startQueuedPeriod(state({ nextBillingPeriod: 'yearly' }), END);
      expect(transition?.next).toMatchObject({
        status: 'active',
        billingPeriod: 'yearly',
        currentPeriodStart: END,
        currentPeriodEnd: baku('2028-04-10T12:00:00'),
        nextBillingPeriod: null,
      });
      expect(transition?.event.kind).toBe('queued_period_started');
    });

    it('turns a trial into an active period', () => {
      const transition = startQueuedPeriod(trialing({ nextBillingPeriod: 'monthly' }), END);
      expect(transition?.next).toMatchObject({ status: 'active', billingPeriod: 'monthly' });
    });

    it('keeps a cancelled subscription cancelled: the queued period was paid, renewal is still off', () => {
      const transition = startQueuedPeriod(cancelled({ nextBillingPeriod: 'monthly' }), END);
      expect(transition?.next.status).toBe('cancelled');
    });

    it('is not due a millisecond before the end, or with nothing queued', () => {
      expect(startQueuedPeriod(state({ nextBillingPeriod: 'yearly' }), BEFORE_END)).toBeNull();
      expect(startQueuedPeriod(state(), AFTER_END)).toBeNull();
    });

    it.each([pastDue({ nextBillingPeriod: 'monthly' }), expired({ nextBillingPeriod: 'monthly' })])(
      'is never due for a %s subscription',
      (subject) => {
        expect(startQueuedPeriod(subject, AFTER_END)).toBeNull();
      },
    );
  });

  describe('entering grace', () => {
    it('runs grace from the period end, exactly at the end', () => {
      const transition = enterGrace(state(), END, GRACE_DAYS);
      expect(transition?.next).toMatchObject({ status: 'past_due', graceEndsAt: GRACE_END });
      expect(transition?.event).toMatchObject({
        kind: 'grace_entered',
        fromStatus: 'active',
        toStatus: 'past_due',
        periodStart: END,
        periodEnd: GRACE_END,
      });
    });

    it('measures grace from the period end, not from when the sweep ran', () => {
      const late = baku('2027-04-11T00:00:00');
      expect(enterGrace(state(), late, GRACE_DAYS)?.next.graceEndsAt).toEqual(GRACE_END);
    });

    it('expires instead when there is no grace to give', () => {
      expect(enterGrace(state(), END, 0)?.next.status).toBe('expired');
      expect(enterGrace(state(), GRACE_END, GRACE_DAYS)?.next.status).toBe('expired');
    });

    it('is not due before the end, or with a period queued', () => {
      expect(enterGrace(state(), BEFORE_END, GRACE_DAYS)).toBeNull();
      expect(enterGrace(state({ nextBillingPeriod: 'monthly' }), AFTER_END, GRACE_DAYS)).toBeNull();
    });

    it.each([
      ['trialing', trialing()],
      ['cancelled', cancelled()],
      ['past_due', pastDue()],
      ['expired', expired()],
    ])('never applies to a %s subscription', (_label, subject) => {
      expect(enterGrace(subject, AFTER_END, GRACE_DAYS)).toBeNull();
    });
  });

  describe('expiring', () => {
    it('expires a trial exactly at its end, with no grace', () => {
      expect(expire(trialing(), BEFORE_END)).toBeNull();
      const transition = expire(trialing(), END);
      expect(transition?.next.status).toBe('expired');
      expect(transition?.event).toMatchObject({ kind: 'expired', fromStatus: 'trialing' });
    });

    it('expires a cancelled period exactly at its end', () => {
      expect(expire(cancelled(), BEFORE_END)).toBeNull();
      expect(expire(cancelled(), END)?.next.status).toBe('expired');
    });

    it('expires grace exactly at the grace end', () => {
      expect(expire(pastDue(), new Date(GRACE_END.getTime() - 1))).toBeNull();
      const transition = expire(pastDue(), GRACE_END);
      expect(transition?.next.status).toBe('expired');
      expect(transition?.event.periodEnd).toEqual(GRACE_END);
    });

    it('leaves alone an active period — that one enters grace first', () => {
      expect(expire(state(), AFTER_END)).toBeNull();
    });

    it('leaves alone a period with one queued behind it', () => {
      expect(expire(trialing({ nextBillingPeriod: 'monthly' }), AFTER_END)).toBeNull();
    });

    it('is never due for an expired subscription', () => {
      expect(expire(expired(), AFTER_END)).toBeNull();
    });
  });

  describe('in order', () => {
    it('starts a queued period before anything else', () => {
      expect(
        nextDueTransition(state({ nextBillingPeriod: 'monthly' }), AFTER_END, GRACE_DAYS)?.event
          .kind,
      ).toBe('queued_period_started');
    });

    it('takes an active period through grace and then to expired', () => {
      const graced = nextDueTransition(state(), AFTER_END, GRACE_DAYS);
      expect(graced?.event.kind).toBe('grace_entered');
      if (graced === null) {
        return;
      }
      expect(nextDueTransition(graced.next, AFTER_END, GRACE_DAYS)).toBeNull();
      expect(nextDueTransition(graced.next, GRACE_END, GRACE_DAYS)?.event.kind).toBe('expired');
    });

    it('has nothing to do for a running subscription', () => {
      expect(nextDueTransition(state(), BEFORE_END, GRACE_DAYS)).toBeNull();
    });
  });
});
