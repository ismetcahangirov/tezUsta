import type { SubscriptionBillingPeriod, SubscriptionStatus } from '@tezusta/types';

import type { SubscriptionEventKind } from '../../infra/database/schema/subscriptions';
import { addBillingPeriod, addCalendarDays } from './subscription-period';

/**
 * The subscription state machine, as pure functions (ADR-0046 § 5, #322).
 *
 * Every function takes where a subscription stands and the time, and returns
 * where it goes and the event that records the move — or refuses. Nothing here
 * reads or writes the database: `SubscriptionsService` locks the row, asks one
 * of these, and writes the answer and its event in one transaction. Keeping
 * the decision pure is what lets every legal **and** illegal transition be
 * tested without a database (CLAUDE.md §13).
 *
 * "Running" means `now` is before the current period's end. The sweep moves a
 * subscription whose period has ended — into the queued period, into grace, or
 * to `expired` — and the service applies the same sweep steps to a row before
 * anything else touches it ({@link nextDueTransition}), so a purchase that
 * lands before the sweep has run sees the same state the sweep would have
 * left.
 */

/** The columns of `master_subscriptions` that the state machine moves. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly billingPeriod: SubscriptionBillingPeriod | null;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly graceEndsAt: Date | null;
  readonly nextBillingPeriod: SubscriptionBillingPeriod | null;
  readonly cancelledAt: Date | null;
}

/** What the event row for one transition says. */
export interface TransitionEvent {
  readonly kind: SubscriptionEventKind;
  readonly fromStatus: SubscriptionStatus | null;
  readonly toStatus: SubscriptionStatus;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly billingPeriod: SubscriptionBillingPeriod | null;
}

export interface Transition {
  readonly next: SubscriptionState;
  readonly event: TransitionEvent;
}

/** Why a transition was refused. Mapped to an HTTP error by the service. */
export type TransitionRefusal =
  'period_already_queued' | 'nothing_to_cancel' | 'trial_does_not_renew' | 'already_cancelled';

export class SubscriptionTransitionRefused extends Error {
  constructor(readonly refusal: TransitionRefusal) {
    super(`Subscription transition refused: ${refusal}`);
    this.name = 'SubscriptionTransitionRefused';
    Object.setPrototypeOf(this, SubscriptionTransitionRefused.prototype);
  }
}

/** The longest admin grant, in days. #324's admin form uses the same bound. */
export const MAX_GRANT_DAYS = 366;

function isRunning(state: SubscriptionState, now: Date): boolean {
  return now.getTime() < state.currentPeriodEnd.getTime();
}

/**
 * Whether a new period has something to queue behind or extend. Not when there
 * is no subscription, when it expired, or when its period is over and only
 * grace is left — in grace, or cancelled in grace.
 *
 * A period that is over with a paid one still queued is a state only a skipped
 * sweep step leaves, and starting fresh from it would throw the queued period
 * away, so it is refused rather than guessed at.
 */
function runningPeriod(
  current: SubscriptionState | undefined,
  now: Date,
): SubscriptionState | null {
  if (current === undefined || current.status === 'expired') {
    return null;
  }
  if (isRunning(current, now)) {
    return current;
  }
  if (current.nextBillingPeriod !== null) {
    throw new Error('A queued period is due to start; apply the sweep steps first.');
  }
  return null;
}

function event(
  kind: SubscriptionEventKind,
  from: SubscriptionState | undefined,
  next: SubscriptionState,
  period: {
    readonly start: Date;
    readonly end: Date;
    readonly billingPeriod: SubscriptionBillingPeriod | null;
  },
): TransitionEvent {
  return {
    kind,
    fromStatus: from?.status ?? null,
    toStatus: next.status,
    periodStart: period.start,
    periodEnd: period.end,
    billingPeriod: period.billingPeriod,
  };
}

/**
 * The entitlement, in TypeScript — the same rule as the SQL predicate in
 * `subscription-entitlement.ts`. A cancelled subscription keeps working to the
 * end of its period (and of its grace, if it was cancelled in grace).
 */
export function isEntitled(state: SubscriptionState, now: Date): boolean {
  if (state.status === 'expired') {
    return false;
  }
  const until = state.graceEndsAt ?? state.currentPeriodEnd;
  return now.getTime() < until.getTime();
}

/** Verification approved a master: the trial starts now (ADR-0046 § 5). */
export function startTrial(now: Date, trialDays: number): Transition {
  const next: SubscriptionState = {
    status: 'trialing',
    billingPeriod: null,
    currentPeriodStart: now,
    currentPeriodEnd: addCalendarDays(now, trialDays),
    graceEndsAt: null,
    nextBillingPeriod: null,
    cancelledAt: null,
  };
  return {
    next,
    event: event('trial_started', undefined, next, {
      start: next.currentPeriodStart,
      end: next.currentPeriodEnd,
      billingPeriod: null,
    }),
  };
}

/** A fresh period starting now — for a master with nothing running. */
function startFresh(
  current: SubscriptionState | undefined,
  now: Date,
  end: Date,
  billingPeriod: SubscriptionBillingPeriod | null,
  kind: SubscriptionEventKind,
): Transition {
  const next: SubscriptionState = {
    status: 'active',
    billingPeriod,
    currentPeriodStart: now,
    currentPeriodEnd: end,
    graceEndsAt: null,
    nextBillingPeriod: null,
    cancelledAt: null,
  };
  return { next, event: event(kind, current, next, { start: now, end, billingPeriod }) };
}

/**
 * A payment bought a period.
 *
 * - Nothing running — no subscription, in grace, or expired: the period
 *   starts now.
 * - A trial, an active period or a cancelled one still running: the new
 *   period is **queued** to start when the current one ends, never overlapping
 *   it (prepaid stacking). Buying again un-cancels.
 * - A period already queued: refused. There is room for one.
 *
 * Expects a subscription the sweep steps have already been applied to.
 */
export function activatePeriod(
  current: SubscriptionState | undefined,
  billingPeriod: SubscriptionBillingPeriod,
  now: Date,
): Transition {
  const running = runningPeriod(current, now);
  if (running === null) {
    return startFresh(
      current,
      now,
      addBillingPeriod(now, billingPeriod),
      billingPeriod,
      'period_activated',
    );
  }

  if (running.nextBillingPeriod !== null) {
    throw new SubscriptionTransitionRefused('period_already_queued');
  }

  const next: SubscriptionState = {
    ...running,
    status: running.status === 'cancelled' ? 'active' : running.status,
    cancelledAt: running.status === 'cancelled' ? null : running.cancelledAt,
    nextBillingPeriod: billingPeriod,
  };
  return {
    next,
    event: event('period_queued', running, next, {
      start: running.currentPeriodEnd,
      end: addBillingPeriod(running.currentPeriodEnd, billingPeriod),
      billingPeriod,
    }),
  };
}

/**
 * An admin granted `days` (ADR-0046 § 5): a promotion, a compensation, or —
 * until a provider is live — how a master who paid offline gets a period.
 *
 * A running period is extended by the grant; otherwise the grant starts now.
 * The billing period last bought is kept, because a grant is not a purchase.
 */
export function grantPeriod(
  current: SubscriptionState | undefined,
  days: number,
  now: Date,
): Transition {
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
    throw new RangeError(`A grant is 1–${String(MAX_GRANT_DAYS)} days, got ${String(days)}.`);
  }

  const running = runningPeriod(current, now);
  if (running === null) {
    return startFresh(
      current,
      now,
      addCalendarDays(now, days),
      current?.billingPeriod ?? null,
      'period_granted',
    );
  }

  const end = addCalendarDays(running.currentPeriodEnd, days);
  const next: SubscriptionState = { ...running, currentPeriodEnd: end };
  return {
    next,
    event: event('period_granted', running, next, {
      start: running.currentPeriodEnd,
      end,
      billingPeriod: running.billingPeriod,
    }),
  };
}

/**
 * The master stopped renewal. What is running keeps running to its end — and
 * to the end of grace, if they cancelled in grace — and does not renew. A
 * period already queued was paid for, so it still starts, still cancelled.
 *
 * A trial is refused: it does not renew, so there is nothing to stop.
 */
export function cancel(current: SubscriptionState | undefined, now: Date): Transition {
  if (current === undefined || current.status === 'expired') {
    throw new SubscriptionTransitionRefused('nothing_to_cancel');
  }
  if (current.status === 'trialing') {
    throw new SubscriptionTransitionRefused('trial_does_not_renew');
  }
  if (current.status === 'cancelled') {
    throw new SubscriptionTransitionRefused('already_cancelled');
  }

  const next: SubscriptionState = { ...current, status: 'cancelled', cancelledAt: now };
  return {
    next,
    event: event('cancelled', current, next, {
      start: current.currentPeriodStart,
      end: current.currentPeriodEnd,
      billingPeriod: current.billingPeriod,
    }),
  };
}

/**
 * Sweep step 1: the running period ended and a paid one is queued, so the
 * queued one starts exactly where the old one ended. `null` when not due.
 */
export function startQueuedPeriod(current: SubscriptionState, now: Date): Transition | null {
  if (
    current.status === 'expired' ||
    current.status === 'past_due' ||
    current.nextBillingPeriod === null ||
    isRunning(current, now)
  ) {
    return null;
  }

  const start = current.currentPeriodEnd;
  const end = addBillingPeriod(start, current.nextBillingPeriod);
  const next: SubscriptionState = {
    ...current,
    status: current.status === 'cancelled' ? 'cancelled' : 'active',
    billingPeriod: current.nextBillingPeriod,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    nextBillingPeriod: null,
  };
  return {
    next,
    event: event('queued_period_started', current, next, {
      start,
      end,
      billingPeriod: next.billingPeriod,
    }),
  };
}

/**
 * Sweep step 2: an active period ended unpaid. Grace runs from the period's
 * end for `graceDays`, read now, so a grace change applies to lapses from now
 * on. With no grace left by the time the sweep gets there — zero days, or a
 * sweep that was down for longer than the grace — the subscription expires
 * instead, rather than recording a grace that never ran.
 *
 * Only `active`: a trial and a cancelled period do not renew, so they have
 * nothing to be late paying for and expire at their end. `null` when not due.
 */
export function enterGrace(
  current: SubscriptionState,
  now: Date,
  graceDays: number,
): Transition | null {
  if (
    current.status !== 'active' ||
    current.nextBillingPeriod !== null ||
    isRunning(current, now)
  ) {
    return null;
  }

  const graceEndsAt = addCalendarDays(current.currentPeriodEnd, graceDays);
  if (now.getTime() >= graceEndsAt.getTime()) {
    const next: SubscriptionState = { ...current, status: 'expired', graceEndsAt };
    return {
      next,
      event: event('expired', current, next, {
        start: current.currentPeriodStart,
        end: graceEndsAt,
        billingPeriod: current.billingPeriod,
      }),
    };
  }

  const next: SubscriptionState = { ...current, status: 'past_due', graceEndsAt };
  return {
    next,
    event: event('grace_entered', current, next, {
      start: current.currentPeriodEnd,
      end: graceEndsAt,
      billingPeriod: current.billingPeriod,
    }),
  };
}

/**
 * Sweep step 3: past the period end and past grace. A trial or a cancelled
 * period with nothing queued expires at its end; one in grace expires at the
 * grace end. `null` when not due.
 */
export function expire(current: SubscriptionState, now: Date): Transition | null {
  if (current.status === 'expired' || current.status === 'active') {
    return null;
  }
  if (current.graceEndsAt === null && current.nextBillingPeriod !== null) {
    return null;
  }
  if (isEntitled(current, now)) {
    return null;
  }

  const next: SubscriptionState = { ...current, status: 'expired' };
  return {
    next,
    event: event('expired', current, next, {
      start: current.currentPeriodStart,
      end: current.graceEndsAt ?? current.currentPeriodEnd,
      billingPeriod: current.billingPeriod,
    }),
  };
}

/**
 * The first sweep step that applies, in the sweep's order. The service applies
 * these until none does before a purchase, a grant or a cancellation, so each
 * of those always starts from the state the sweep would have left.
 */
export function nextDueTransition(
  current: SubscriptionState,
  now: Date,
  graceDays: number,
): Transition | null {
  return (
    startQueuedPeriod(current, now) ?? enterGrace(current, now, graceDays) ?? expire(current, now)
  );
}
