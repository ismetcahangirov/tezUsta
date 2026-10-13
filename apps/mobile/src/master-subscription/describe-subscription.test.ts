import type { MasterSubscription } from '@tezusta/types';

import { describeSubscription } from './describe-subscription';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';

const NOW = new Date('2027-03-10T12:00:00Z');
const DAY = 86_400_000;

function subscription(overrides: Partial<MasterSubscription> = {}): MasterSubscription {
  return {
    status: 'active',
    billingPeriod: 'monthly',
    currentPeriodStart: '2027-03-01T12:00:00.000Z',
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    graceEndsAt: null,
    nextBillingPeriod: null,
    entitled: true,
    ...overrides,
  };
}

describe('describeSubscription', () => {
  it('says a master with no subscription yet gets a trial at approval', () => {
    expect(describeSubscription(null, NOW, 'en-GB')).toEqual({
      tone: 'pending',
      label: copy.status.none,
      line: copy.line.none,
      next: null,
      warning: null,
      receivesWork: false,
    });
  });

  it('shows when a trial ends', () => {
    const summary = describeSubscription(
      subscription({ status: 'trialing', billingPeriod: null }),
      NOW,
      'en-GB',
    );
    expect(summary).toMatchObject({ tone: 'active', label: copy.status.trialing, warning: null });
    expect(summary.line).toBe(copy.line.runsUntil('30 Mar 2027'));
  });

  it('names the billing period of an active subscription', () => {
    expect(describeSubscription(subscription(), NOW, 'en-GB').label).toBe(
      `${copy.status.active} · ${copy.period.monthly}`,
    );
  });

  it('warns three days before the end, and not four', () => {
    const inThree = subscription({
      currentPeriodEnd: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    });
    const inFour = subscription({
      currentPeriodEnd: new Date(NOW.getTime() + 4 * DAY).toISOString(),
    });
    expect(describeSubscription(inThree, NOW, 'en-GB').warning).toEqual({
      tone: 'neutral',
      message: copy.warning.ending('13 Mar 2027'),
    });
    expect(describeSubscription(inFour, NOW, 'en-GB').warning).toBeNull();
  });

  it('does not warn of an end when a paid period is queued, and names the queued one', () => {
    const summary = describeSubscription(
      subscription({
        currentPeriodEnd: new Date(NOW.getTime() + DAY).toISOString(),
        nextBillingPeriod: 'yearly',
      }),
      NOW,
      'en-GB',
    );
    expect(summary.warning).toBeNull();
    expect(summary.next).toBe(copy.next('yearly', '11 Mar 2027'));
  });

  it('shows grace and until when work keeps coming', () => {
    const summary = describeSubscription(
      subscription({
        status: 'past_due',
        currentPeriodEnd: new Date(NOW.getTime() - DAY).toISOString(),
        graceEndsAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      }),
      NOW,
      'en-GB',
    );
    expect(summary).toMatchObject({
      tone: 'pending',
      label: copy.status.past_due,
      warning: { tone: 'danger', message: copy.warning.grace('12 Mar 2027') },
    });
  });

  it('says a cancelled subscription runs to its end and does not renew', () => {
    const summary = describeSubscription(subscription({ status: 'cancelled' }), NOW, 'en-GB');
    expect(summary).toMatchObject({ tone: 'pending', label: copy.status.cancelled });
    expect(summary.line).toBe(copy.line.cancelledUntil('30 Mar 2027'));
  });

  it('does not say "will not renew" when a paid period is queued after a cancellation', () => {
    const summary = describeSubscription(
      subscription({ status: 'cancelled', nextBillingPeriod: 'monthly' }),
      NOW,
      'en-GB',
    );
    expect(summary.label).toBe(copy.status.cancelled);
    expect(summary.line).toBe(copy.line.runsUntil('30 Mar 2027'));
    expect(summary.next).toBe(copy.next('monthly', '30 Mar 2027'));
  });

  it.each([
    ['an expired subscription', subscription({ status: 'expired', entitled: false })],
    // The server has not swept it yet; `entitled` already says it is over.
    ['one past its end the sweep has not reached', subscription({ entitled: false })],
  ])('says work has stopped for %s', (_label, subject) => {
    expect(describeSubscription(subject, NOW, 'en-GB')).toMatchObject({
      tone: 'cancelled',
      label: copy.status.expired,
      warning: { tone: 'danger', message: copy.warning.expired },
    });
  });

  it('says a cancelled subscription in grace is cancelled, and until when work keeps coming', () => {
    const summary = describeSubscription(
      subscription({
        status: 'cancelled',
        currentPeriodEnd: new Date(NOW.getTime() - DAY).toISOString(),
        graceEndsAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      }),
      NOW,
      'en-GB',
    );
    expect(summary).toMatchObject({
      tone: 'pending',
      label: copy.status.cancelled,
      line: copy.line.graceUntil('12 Mar 2027'),
      receivesWork: true,
    });
  });

  // A home left open outlives its read: the server's own test is
  // `now < coalesce(grace end, period end)`, and the card applies it too.
  it.each([
    [
      'a period',
      subscription({ currentPeriodEnd: new Date(NOW.getTime() - 60_000).toISOString() }),
    ],
    [
      'a grace',
      subscription({
        status: 'past_due',
        currentPeriodEnd: new Date(NOW.getTime() - 3 * DAY).toISOString(),
        graceEndsAt: new Date(NOW.getTime() - 60_000).toISOString(),
      }),
    ],
  ])('reads %s that has ended since the last read as stopped', (_label, subject) => {
    expect(subject.entitled).toBe(true);
    expect(describeSubscription(subject, NOW, 'en-GB')).toMatchObject({
      tone: 'cancelled',
      label: copy.status.expired,
      warning: { tone: 'danger', message: copy.warning.expired },
      receivesWork: false,
    });
  });

  it('names the queued period in lower case without a stray dot on the İ', () => {
    expect(copy.next('yearly', '1 Apr 2027')).toBe('Növbəti: illik, 1 Apr 2027 tarixindən');
  });

  it('never mentions a price', () => {
    const everything = JSON.stringify(copy);
    expect(everything).not.toMatch(/₼|AZN|manat/i);
  });
});
