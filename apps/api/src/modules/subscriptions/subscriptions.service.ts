import { Inject, Injectable } from '@nestjs/common';
import type {
  MasterSubscription,
  SubscriptionBillingPeriod,
  SubscriptionOffer,
  SubscriptionPrice,
} from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import type { Clock } from '../../common/time/clock';
import { CLOCK } from '../../common/time/clock';
import { isUniqueViolationOn } from '../../infra/database/database-error';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import type {
  MasterSubscriptionRow,
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
import type { EventPayment, SubscriptionActor } from './subscriptions.repository';
import { SubscriptionsRepository, toState } from './subscriptions.repository';

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

function toPrice(row: SubscriptionPriceRow | undefined): SubscriptionPrice | null {
  if (row === undefined) {
    return null;
  }
  return {
    billingPeriod: row.billingPeriod,
    priceMinor: row.priceMinor,
    currency: 'AZN',
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
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
    try {
      await this.repository.transaction(async (tx) => {
        await this.repository.lockMaster(tx, input.masterId);
        if (await this.repository.hasPaymentRef(input.paymentRef, tx)) {
          return;
        }

        const price = await this.repository.findPrice(input.priceId, tx);
        if (price?.billingPeriod !== input.billingPeriod) {
          // The provider adapter passes back what the checkout recorded; a
          // mismatch is a bug in that adapter, not a request to correct.
          throw new Error(
            `Price ${input.priceId} is not a ${input.billingPeriod} price; the period was not activated.`,
          );
        }

        const now = this.clock.now();
        await this.applyTransition(tx, input.masterId, now, {
          decide: (current) => activatePeriod(current, input.billingPeriod, now),
          actor: PROVIDER,
          payment: {
            priceId: price.id,
            amountMinor: price.priceMinor,
            paymentRef: input.paymentRef,
          },
        });
      });
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
   */
  async grantPeriod(input: {
    readonly masterId: string;
    readonly adminUserId: string;
    readonly days: number;
    readonly reason: string;
  }): Promise<MasterSubscription> {
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new RangeError('A grant needs a reason.');
    }

    await this.repository.transaction(async (tx) => {
      await this.repository.lockMaster(tx, input.masterId);
      const now = this.clock.now();
      await this.applyTransition(tx, input.masterId, now, {
        decide: (current) => grantPeriod(current, input.days, now),
        actor: { kind: 'admin', adminUserId: input.adminUserId },
        reason,
      });
    });
    return this.readOwn(input.masterId);
  }

  /** Stops renewal. What is running runs to its end. */
  async cancel(masterId: string, actor: SubscriptionActor): Promise<MasterSubscription> {
    await this.repository.transaction(async (tx) => {
      await this.repository.lockMaster(tx, masterId);
      const now = this.clock.now();
      await this.applyTransition(tx, masterId, now, {
        decide: (current) => cancel(current, now),
        actor,
      });
    });
    return this.readOwn(masterId);
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
   * with the sweep, then decide, then write.
   */
  private async applyTransition(
    tx: DatabaseExecutor,
    masterId: string,
    now: Date,
    change: {
      readonly decide: (current: SubscriptionState | undefined) => Transition;
      readonly actor: SubscriptionActor;
      readonly reason?: string;
      readonly payment?: EventPayment;
    },
  ): Promise<void> {
    let row = await this.repository.findByMasterId(masterId, tx);

    if (row !== undefined) {
      const { graceDays } = await this.repository.readSettings(tx);
      for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
        const due = nextDueTransition(toState(row), now, graceDays);
        if (due === null) {
          break;
        }
        row = await this.write(tx, row, due, { actor: SYSTEM, now });
      }
    }

    let transition: Transition;
    try {
      transition = change.decide(row === undefined ? undefined : toState(row));
    } catch (error) {
      throw asHttpError(error);
    }

    const written = { actor: change.actor, reason: change.reason, payment: change.payment, now };
    if (row !== undefined) {
      await this.write(tx, row, transition, written);
      return;
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
    return updated;
  }

  /** One sweep pass over `masterIds`: lock, re-read, decide, write. Returns how many moved. */
  private async sweep(
    masterIds: readonly string[],
    decide: (state: SubscriptionState, settings: SubscriptionSettingsRow) => Transition | null,
    now: Date,
  ): Promise<number> {
    let moved = 0;
    for (const masterId of masterIds) {
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
        await this.write(tx, row, transition, { actor: SYSTEM, now });
        return true;
      });
      if (didMove) {
        moved += 1;
      }
    }
    return moved;
  }
}
