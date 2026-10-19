import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminDashboardSubscriptions,
  AdminMasterSubscription,
  MasterSubscription,
  SubscriptionBillingPeriod,
  SubscriptionOffer,
  SubscriptionPrice,
  SubscriptionStatus,
} from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import { isUniqueViolationOn } from '../../infra/database/database-error';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type {
  MasterSubscriptionRow,
  SubscriptionNoticeKind,
  SubscriptionPriceRow,
  SubscriptionSettingsRow,
} from '../../infra/database/schema/subscriptions';
import type { SubscriptionState, Transition } from './subscription-transitions';
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
import {
  SubscriptionInactiveError,
  SubscriptionPeriodAlreadyQueuedError,
  SubscriptionTransitionNotAllowedError,
} from './subscriptions.errors';
import type {
  EventPayment,
  SubscriptionActor,
  SubscriptionAuditRecorder,
} from './subscriptions.repository';
import { SubscriptionsRepository, toState } from './subscriptions.repository';
import type { SubscriptionNotice } from './subscription-notices.registry';
import { SubscriptionNoticesRegistry } from './subscription-notices.registry';
import { addCalendarDays } from './subscription-period';

const SYSTEM: SubscriptionActor = Object.freeze({ kind: 'system' });
const PROVIDER: SubscriptionActor = Object.freeze({ kind: 'provider' });

/** More sweep steps than any row can owe at once: queued start, grace, expiry. */
const MAX_CATCH_UP_STEPS = 4;

const REFUSAL_MESSAGES = Object.freeze({
  nothing_to_cancel: 'There is no running subscription to cancel.',
  trial_does_not_renew: 'A trial does not renew, so there is nothing to cancel.',
  already_cancelled: 'This subscription is already cancelled.',
});

/** A pure transition refusal, as the error a client sees. */
function asHttpError(error: unknown): unknown {
  if (!(error instanceof SubscriptionTransitionRefused)) {
    return error;
  }
  if (error.refusal === 'period_already_queued') {
    return new SubscriptionPeriodAlreadyQueuedError();
  }
  return new SubscriptionTransitionNotAllowedError(REFUSAL_MESSAGES[error.refusal]);
}

/** How many of a master's events the admin view shows, newest first. */
const ADMIN_EVENT_LIMIT = 100;

export function toPrice(row: SubscriptionPriceRow | undefined): SubscriptionPrice | null {
  if (row?.priceMinor === undefined || row.priceMinor === null) {
    return null;
  }
  return {
    billingPeriod: row.billingPeriod,
    priceMinor: row.priceMinor,
    currency: 'AZN',
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
}

/** How far ahead of a period's end the master is warned (#326). */
export const ENDING_NOTICE_DAYS = 3;

/**
 * The ledger key of a push about a period end: its epoch milliseconds, the
 * same value `listEndingSoon` computes in SQL. Milliseconds, not ISO text,
 * because a row written by SQL carries microseconds a JavaScript `Date` drops.
 */
function noticeKey(periodEnd: Date): string {
  return String(periodEnd.getTime());
}

/**
 * The push a transition raises, if any, and the ledger key that makes it
 * once-only (#326). Grace and expiry say the period lapsed; a period bought
 * by a confirmed payment — not a trial, a grant or a sweep — says it renewed.
 */
function noticeFor(
  masterId: string,
  before: MasterSubscriptionRow,
  transition: Transition,
  actor: SubscriptionActor,
): {
  readonly ledger: SubscriptionNoticeKind;
  readonly key: string;
  readonly push: SubscriptionNotice;
} | null {
  const { event, next } = transition;
  switch (event.kind) {
    case 'grace_entered':
      return {
        ledger: 'grace',
        key: noticeKey(before.currentPeriodEnd),
        push: {
          masterId,
          kind: 'subscription-grace',
          billingPeriod: next.billingPeriod,
          endsAt: next.graceEndsAt ?? undefined,
        },
      };
    case 'expired':
      return {
        ledger: 'expired',
        key: noticeKey(next.currentPeriodEnd),
        push: { masterId, kind: 'subscription-expired', billingPeriod: next.billingPeriod },
      };
    case 'period_activated':
    case 'period_queued':
      if (actor.kind !== 'provider') {
        return null;
      }
      return {
        ledger: 'renewed',
        key: noticeKey(event.periodEnd),
        push: {
          masterId,
          kind: 'subscription-renewed',
          billingPeriod: event.billingPeriod,
          endsAt: event.periodEnd,
        },
      };
    default:
      return null;
  }
}

/** A payment or a grant that starts a new period now, replacing whatever had lapsed. */
function startsFreshPeriod(transition: Transition, now: Date): boolean {
  const { kind } = transition.event;
  return (
    (kind === 'period_activated' || kind === 'period_granted') &&
    transition.next.currentPeriodStart.getTime() === now.getTime()
  );
}

/** The fields an admin audit row records about a subscription, before and after. */
function auditFields(row: MasterSubscriptionRow | undefined): Record<string, unknown> {
  if (row === undefined) {
    return { status: null };
  }
  return {
    status: row.status,
    billingPeriod: row.billingPeriod,
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
    nextBillingPeriod: row.nextBillingPeriod,
  };
}

function auditChange(change: {
  before: MasterSubscriptionRow | undefined;
  after: MasterSubscriptionRow;
}): { before: Record<string, unknown>; after: Record<string, unknown> } {
  return { before: auditFields(change.before), after: auditFields(change.after) };
}

/**
 * The master subscription (ADR-0046 § 5, issue #322).
 *
 * **The only writer of `master_subscriptions` and `subscription_events`.**
 * Every transition is the same four steps, in one transaction:
 *
 * 1. Take the master's advisory lock, so two writes to one subscription —
 *    two confirmations of one payment, a renewal and the expiry sweep — run
 *    one after the other.
 * 2. Apply any sweep step the row is already due (a queued period starting,
 *    grace, expiry), so a purchase that lands before the sweep sees what the
 *    sweep would have left.
 * 3. Ask `subscription-transitions.ts` where the row goes.
 * 4. A conditional UPDATE, and one event row.
 *
 * Time comes from the injected {@link Clock}, so a test can stand exactly on
 * a boundary. The entitlement itself is read by the database's clock
 * (`subscription-entitlement.ts`), the same one the dispatch query uses.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly repository: SubscriptionsRepository,
    private readonly notices: SubscriptionNoticesRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Verification approved a master: their trial starts, with the trial length
   * the settings hold right now.
   *
   * A master who already has a subscription keeps it — a reinstatement after
   * a suspension does not hand out a second trial — so this returns `false`
   * and writes nothing.
   *
   * Pass the approval's transaction as `executor`: the trial and the approval
   * commit together or not at all (#322).
   */
  async startTrial(masterId: string, executor?: DatabaseExecutor): Promise<boolean> {
    const work = async (tx: DatabaseExecutor): Promise<boolean> => {
      await this.repository.lockMaster(tx, masterId);
      if ((await this.repository.findByMasterId(masterId, tx)) !== undefined) {
        return false;
      }

      const now = this.clock.now();
      const { trialDays } = await this.repository.readSettings(tx);
      const transition = startTrial(now, trialDays);
      const row = await this.repository.insert(tx, masterId, transition.next, now);
      if (row === undefined) {
        return false;
      }
      await this.repository.appendEvent(tx, {
        masterSubscriptionId: row.id,
        event: transition.event,
        actor: SYSTEM,
        now,
      });
      return true;
    };

    return executor === undefined ? this.repository.transaction(work) : work(executor);
  }

  /**
   * A confirmed payment bought a period (#323 calls this from a verified
   * provider webhook, and from nowhere else).
   *
   * **Idempotent on `paymentRef`.** A provider that delivers one confirmation
   * twice — or twice at the same moment — extends the subscription once: the
   * second call finds the reference under the master's lock and changes
   * nothing. The unique index on `payment_ref` is the backstop if two masters'
   * calls ever carried one reference.
   *
   * The price is the version the payment was taken against, whether or not it
   * is still current: a checkout that started before a price change is
   * honoured at the price it showed.
   */
  async activatePeriod(input: {
    readonly masterId: string;
    readonly billingPeriod: SubscriptionBillingPeriod;
    readonly priceId: string;
    readonly paymentRef: string;
  }): Promise<MasterSubscription> {
    const notices: SubscriptionNotice[] = [];
    try {
      await this.repository.transaction(async (tx) => {
        await this.repository.lockMaster(tx, input.masterId);
        if (await this.repository.hasPaymentRef(input.paymentRef, tx)) {
          return;
        }

        const price = await this.repository.findPrice(input.priceId, tx);
        if (price?.billingPeriod !== input.billingPeriod || price.priceMinor === null) {
          // The provider adapter passes back what the checkout recorded; a
          // mismatch is a bug in that adapter, not a request to correct.
          throw new Error(
            `Price ${input.priceId} is not a payable ${input.billingPeriod} price; the period was not activated.`,
          );
        }

        const now = this.clock.now();
        await this.applyTransition(tx, input.masterId, now, notices, {
          decide: (current) => activatePeriod(current, input.billingPeriod, now),
          actor: PROVIDER,
          payment: {
            priceId: price.id,
            amountMinor: price.priceMinor,
            paymentRef: input.paymentRef,
          },
        });
      });
      // After commit only: a push for a payment that rolled back would be a lie.
      await this.notices.raise(notices);
    } catch (error) {
      if (!isUniqueViolationOn(error, 'subscription_events_payment_ref_unique')) {
        throw error;
      }
      // Already applied — by a call that held a different master's lock with
      // the same reference. Nothing more to do.
    }
    return this.readOwn(input.masterId);
  }

  /**
   * An admin granted days, with a reason (ADR-0046 § 5; the admin surface is
   * #324). A running period is extended; otherwise the grant starts now.
   *
   * Only a master verification has approved can be granted days: an active
   * one, or a suspended one, since compensating a suspension later judged
   * unfair is what a grant is for. A master not yet approved gets their trial
   * at approval (#322), and `startTrial` gives none to a master who already
   * has a subscription, so a grant before approval would take that trial away
   * and run its days down while the master cannot work. The status is read
   * under a row lock inside the grant's transaction, so a review that commits
   * while the grant runs cannot slip past it (#391).
   *
   * `record` is the admin audit writer. It runs inside this transaction with
   * the subscription before and after, so a grant and its audit row commit
   * together or not at all.
   */
  async grantPeriod(
    input: {
      readonly masterId: string;
      readonly adminUserId: string;
      readonly days: number;
      readonly reason: string;
    },
    record?: SubscriptionAuditRecorder,
  ): Promise<MasterSubscription> {
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new RangeError('A grant needs a reason.');
    }

    const notices: SubscriptionNotice[] = [];
    await this.repository.transaction(async (tx) => {
      const verification = await this.repository.lockVerificationStatus(tx, input.masterId);
      if (verification !== 'active' && verification !== 'suspended') {
        throw new SubscriptionTransitionNotAllowedError(
          'Days can be granted once verification has approved the master.',
        );
      }
      await this.repository.lockMaster(tx, input.masterId);
      const now = this.clock.now();
      const change = await this.applyTransition(tx, input.masterId, now, notices, {
        decide: (current) => grantPeriod(current, input.days, now),
        actor: { kind: 'admin', adminUserId: input.adminUserId },
        reason,
      });
      await record?.(tx, { targetId: input.masterId, ...auditChange(change) });
    });
    await this.notices.raise(notices);
    return this.readOwn(input.masterId);
  }

  /**
   * Stops renewal. What is running runs to its end. `record`, when given,
   * writes the admin audit row inside the same transaction.
   */
  async cancel(
    masterId: string,
    actor: SubscriptionActor,
    options: { readonly reason?: string; readonly record?: SubscriptionAuditRecorder } = {},
  ): Promise<MasterSubscription> {
    const notices: SubscriptionNotice[] = [];
    await this.repository.transaction(async (tx) => {
      await this.repository.lockMaster(tx, masterId);
      const now = this.clock.now();
      const change = await this.applyTransition(tx, masterId, now, notices, {
        decide: (current) => cancel(current, now),
        actor,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
      await options.record?.(tx, { targetId: masterId, ...auditChange(change) });
    });
    await this.notices.raise(notices);
    return this.readOwn(masterId);
  }

  /** One master's subscription and history, for the admin panel (#324). */
  async adminView(masterId: string): Promise<AdminMasterSubscription> {
    const row = await this.repository.findByMasterId(masterId);
    if (row === undefined) {
      return { subscription: null, events: [] };
    }
    const events = await this.repository.listEvents(row.id, ADMIN_EVENT_LIMIT);
    return {
      subscription: this.toView(row),
      events: events.map((event) => ({
        kind: event.kind,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        periodStart: event.periodStart.toISOString(),
        periodEnd: event.periodEnd.toISOString(),
        billingPeriod: event.billingPeriod,
        amountMinor: event.amountMinor,
        actor: event.actor,
        reason: event.reason,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /** Each master's subscription status, for one page of the admin masters list. */
  async statusesFor(masterIds: readonly string[]): Promise<Map<string, SubscriptionStatus>> {
    return this.repository.statusesFor(masterIds);
  }

  async dashboardCounts(): Promise<AdminDashboardSubscriptions> {
    return this.repository.dashboardCounts(this.clock.now());
  }

  /*
   * The sweep (`maintenance-subscriptions`). Each method moves at most
   * `limit` subscriptions per list and returns how many it moved, so the
   * maintenance job can run it in bounded batches. Each row is locked and
   * re-checked before it moves: one that a purchase reached first is simply
   * no longer due.
   */

  /** Running periods that ended with a paid one queued: the queued one starts. */
  async startQueuedPeriods(now: Date, limit: number): Promise<number> {
    const due = await this.repository.listQueuedDue(now, limit);
    return this.sweep(due, (state) => startQueuedPeriod(state, now), now);
  }

  /**
   * Active periods that ended unpaid enter grace, with `grace_days` read at
   * this moment — so a grace change applies to lapses from now on.
   */
  async enterGrace(now: Date, limit: number): Promise<number> {
    const due = await this.repository.listGraceDue(now, limit);
    return this.sweep(due, (state, settings) => enterGrace(state, now, settings.graceDays), now);
  }

  /** Trials, cancelled periods and grace that have run out. */
  async expireDue(now: Date, limit: number): Promise<number> {
    const atPeriodEnd = await this.repository.listPeriodExpiryDue(now, limit);
    const atGraceEnd = await this.repository.listGraceExpiryDue(now, limit);
    const decide = (state: SubscriptionState): Transition | null => expire(state, now);
    return (
      (await this.sweep(atPeriodEnd, decide, now)) + (await this.sweep(atGraceEnd, decide, now))
    );
  }

  /**
   * The three-day warning (#326), from the maintenance sweep: every period
   * ending within {@link ENDING_NOTICE_DAYS} with nothing queued after it, once
   * per period. Returns how many were claimed, for the sweep's bounded batches.
   */
  async noticeEndingSoon(now: Date, limit: number): Promise<number> {
    const due = await this.repository.listEndingSoon(
      now,
      addCalendarDays(now, ENDING_NOTICE_DAYS),
      limit,
    );
    const notices: SubscriptionNotice[] = [];
    for (const row of due) {
      const claimed = await this.repository.transaction((tx) =>
        this.repository.claimNotice(tx, row.id, 'ending', noticeKey(row.currentPeriodEnd)),
      );
      if (claimed) {
        notices.push({
          masterId: row.masterId,
          kind: 'subscription-ending',
          billingPeriod: row.billingPeriod,
          endsAt: row.currentPeriodEnd,
        });
      }
    }
    await this.notices.raise(notices);
    return notices.length;
  }

  /**
   * The price-change notice (#326, ADR-0046 § 6), from the maintenance sweep:
   * for every price version still scheduled, each master whose next renewal
   * is on that period and who has not been told about that version yet.
   *
   * From the sweep rather than from the admin request, so a notice cut short
   * by an error resumes on the next run instead of being lost, and a master
   * who buys that period after the change was scheduled is told too. Returns
   * how many were claimed, for the sweep's bounded batches.
   */
  async noticeScheduledPrices(now: Date, limit: number): Promise<number> {
    let sent = 0;
    for (const price of await this.repository.scheduledPrices(now)) {
      const due = await this.repository.listAwaitingPriceNotice(price, limit);
      const notices: SubscriptionNotice[] = [];
      for (const row of due) {
        const claimed = await this.repository.transaction((tx) =>
          this.repository.claimNotice(tx, row.id, 'price_change', price.id),
        );
        if (claimed) {
          notices.push({
            masterId: row.masterId,
            kind: 'subscription-price-change',
            billingPeriod: price.billingPeriod,
            effectiveFrom: price.effectiveFrom,
          });
        }
      }
      await this.notices.raise(notices);
      sent += notices.length;
    }
    return sent;
  }

  /** May this master take new work, by their subscription? Read by the database's clock. */
  async isEntitled(masterId: string): Promise<boolean> {
    return this.repository.isEntitled(masterId);
  }

  async assertEntitled(masterId: string): Promise<void> {
    if (!(await this.repository.isEntitled(masterId))) {
      throw new SubscriptionInactiveError();
    }
  }

  /** The master's own subscription. 404 for a master who has none — not yet approved. */
  async readOwn(masterId: string): Promise<MasterSubscription> {
    const row = await this.repository.findByMasterId(masterId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return this.toView(row);
  }

  /** The subscription as it is offered now: both current prices, trial, grace, and whether purchases are open. */
  async offer(): Promise<SubscriptionOffer> {
    const [settings, prices] = await Promise.all([
      this.repository.readSettings(),
      this.repository.currentPrices(this.clock.now()),
    ]);
    return {
      monthly: toPrice(prices.find((price) => price.billingPeriod === 'monthly')),
      yearly: toPrice(prices.find((price) => price.billingPeriod === 'yearly')),
      trialDays: settings.trialDays,
      graceDays: settings.graceDays,
      purchasesOpen: settings.purchasesOpen,
    };
  }

  private toView(row: MasterSubscriptionRow): MasterSubscription {
    return {
      status: row.status,
      billingPeriod: row.billingPeriod,
      currentPeriodStart: row.currentPeriodStart.toISOString(),
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
      nextBillingPeriod: row.nextBillingPeriod,
      entitled: isEntitled(toState(row), this.clock.now()),
    };
  }

  /**
   * Steps 2–4 of every transition, under the caller's lock: catch the row up
   * with the sweep, then decide, then write. Returns the row as the decision
   * found it (after catching up) and as it left it.
   */
  private async applyTransition(
    tx: DatabaseExecutor,
    masterId: string,
    now: Date,
    notices: SubscriptionNotice[],
    change: {
      readonly decide: (current: SubscriptionState | undefined) => Transition;
      readonly actor: SubscriptionActor;
      readonly reason?: string;
      readonly payment?: EventPayment;
    },
  ): Promise<{ before: MasterSubscriptionRow | undefined; after: MasterSubscriptionRow }> {
    let row = await this.repository.findByMasterId(masterId, tx);

    // The catch-up steps' pushes are held back until the change is decided:
    // a lapse the same transaction then replaces with a fresh period — a
    // payment or a grant landing in the minute before the sweep — is not
    // worth a "your subscription has ended" beside "renewed" (#326).
    const catchUpNotices: SubscriptionNotice[] = [];
    if (row !== undefined) {
      const { graceDays } = await this.repository.readSettings(tx);
      for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
        const due = nextDueTransition(toState(row), now, graceDays);
        if (due === null) {
          break;
        }
        row = await this.write(tx, row, due, { actor: SYSTEM, now }, catchUpNotices);
      }
    }

    let transition: Transition;
    try {
      transition = change.decide(row === undefined ? undefined : toState(row));
    } catch (error) {
      throw asHttpError(error);
    }
    if (!startsFreshPeriod(transition, now)) {
      notices.push(...catchUpNotices);
    }

    const written = { actor: change.actor, reason: change.reason, payment: change.payment, now };
    if (row !== undefined) {
      return { before: row, after: await this.write(tx, row, transition, written, notices) };
    }

    const created = await this.repository.insert(tx, masterId, transition.next, now);
    if (created === undefined) {
      // The advisory lock makes this unreachable: nobody else can create the
      // row while this transaction holds it.
      throw new Error(`A subscription for master ${masterId} appeared under its lock.`);
    }
    await this.repository.appendEvent(tx, {
      masterSubscriptionId: created.id,
      event: transition.event,
      ...written,
    });
    await this.collectNotice(tx, created, created, transition, change.actor, notices);
    return { before: undefined, after: created };
  }

  private async write(
    tx: DatabaseExecutor,
    row: MasterSubscriptionRow,
    transition: Transition,
    context: {
      readonly actor: SubscriptionActor;
      readonly reason?: string | undefined;
      readonly payment?: EventPayment | undefined;
      readonly now: Date;
    },
    notices: SubscriptionNotice[],
  ): Promise<MasterSubscriptionRow> {
    const updated = await this.repository.update(
      tx,
      row.id,
      toState(row),
      transition.next,
      context.now,
    );
    if (updated === undefined) {
      throw new Error(`Subscription ${row.id} moved under its lock.`);
    }
    await this.repository.appendEvent(tx, {
      masterSubscriptionId: row.id,
      event: transition.event,
      ...context,
    });
    await this.collectNotice(tx, row, updated, transition, context.actor, notices);
    return updated;
  }

  /**
   * Claims the push a transition raises in the ledger, inside the
   * transition's own transaction, and queues it to be raised after commit
   * (#326). A push already claimed — a retried confirmation, a re-run sweep —
   * is not queued again.
   */
  private async collectNotice(
    tx: DatabaseExecutor,
    before: MasterSubscriptionRow,
    after: MasterSubscriptionRow,
    transition: Transition,
    actor: SubscriptionActor,
    notices: SubscriptionNotice[],
  ): Promise<void> {
    const notice = noticeFor(after.masterId, before, transition, actor);
    if (notice === null) {
      return;
    }
    if (await this.repository.claimNotice(tx, after.id, notice.ledger, notice.key)) {
      notices.push(notice.push);
    }
  }

  /** One sweep pass over `masterIds`: lock, re-read, decide, write. Returns how many moved. */
  private async sweep(
    masterIds: readonly string[],
    decide: (state: SubscriptionState, settings: SubscriptionSettingsRow) => Transition | null,
    now: Date,
  ): Promise<number> {
    let moved = 0;
    for (const masterId of masterIds) {
      const notices: SubscriptionNotice[] = [];
      const didMove = await this.repository.transaction(async (tx) => {
        await this.repository.lockMaster(tx, masterId);
        const row = await this.repository.findByMasterId(masterId, tx);
        if (row === undefined) {
          return false;
        }
        const settings = await this.repository.readSettings(tx);
        const transition = decide(toState(row), settings);
        if (transition === null) {
          return false;
        }
        await this.write(tx, row, transition, { actor: SYSTEM, now }, notices);
        return true;
      });
      await this.notices.raise(notices);
      if (didMove) {
        moved += 1;
      }
    }
    return moved;
  }
}
