import type { MasterSubscription } from '@tezusta/types';

import type { StatusTone } from '../components/StatusPill';
import { formatSubscriptionDate } from './format-subscription-date';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';

/** How far ahead of the end the master is warned — the same three days as the push (#326). */
export const ENDING_WARNING_DAYS = 3;

const DAY_MS = 86_400_000;

export interface SubscriptionWarning {
  readonly message: string;
  /** `danger` once work has stopped or is about to; `neutral` for the heads-up. */
  readonly tone: 'neutral' | 'danger';
}

export interface SubscriptionSummary {
  readonly tone: StatusTone;
  readonly label: string;
  readonly line: string;
  /** The queued period, when one is paid for in advance. */
  readonly next: string | null;
  readonly warning: SubscriptionWarning | null;
}

/**
 * Where a master's subscription stands, in the words the home card uses
 * (#325, ADR-0048). Pure, so every state is a unit test.
 *
 * `null` is a master with no subscription yet — verification has not approved
 * them. The server's `entitled` decides "stopped": an expired row, and a
 * period or grace the sweep has not caught up with, both read as over.
 */
export function describeSubscription(
  subscription: MasterSubscription | null,
  now: Date,
  locale?: string,
): SubscriptionSummary {
  if (subscription === null) {
    return {
      tone: 'pending',
      label: copy.status.none,
      line: copy.line.none,
      next: null,
      warning: null,
    };
  }

  const date = (iso: string): string => formatSubscriptionDate(iso, locale);
  const end = date(subscription.currentPeriodEnd);
  const next =
    subscription.nextBillingPeriod === null
      ? null
      : copy.next(copy.period[subscription.nextBillingPeriod], end);

  if (!subscription.entitled) {
    return {
      tone: 'cancelled',
      label: copy.status.expired,
      line: copy.line.expired,
      next: null,
      warning: { message: copy.warning.expired, tone: 'danger' },
    };
  }

  if (subscription.graceEndsAt !== null) {
    const graceEnd = date(subscription.graceEndsAt);
    return {
      tone: 'pending',
      label: copy.status[subscription.status === 'cancelled' ? 'cancelled' : 'past_due'],
      line: copy.line.graceUntil(graceEnd),
      next: null,
      warning: { message: copy.warning.grace(graceEnd), tone: 'danger' },
    };
  }

  const endsSoon =
    subscription.nextBillingPeriod === null &&
    new Date(subscription.currentPeriodEnd).getTime() - now.getTime() <=
      ENDING_WARNING_DAYS * DAY_MS;
  const warning: SubscriptionWarning | null = endsSoon
    ? { message: copy.warning.ending(end), tone: 'neutral' }
    : null;

  if (subscription.status === 'cancelled') {
    return {
      tone: 'pending',
      label: copy.status.cancelled,
      line: copy.line.cancelledUntil(end),
      next,
      warning,
    };
  }

  const label =
    subscription.status === 'trialing'
      ? copy.status.trialing
      : subscription.billingPeriod === null
        ? copy.status.active
        : `${copy.status.active} · ${copy.period[subscription.billingPeriod]}`;

  return { tone: 'active', label, line: copy.line.runsUntil(end), next, warning };
}
