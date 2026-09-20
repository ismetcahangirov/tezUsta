import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../../infra/queue/deferred-work.service';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import { assertOrderTransition } from '../orders/order-lifecycle';
import { OrdersRepository } from '../orders/orders.repository';
import { DISPATCH_RECONCILE_JOB, dispatchGiveUpJobId } from './dispatch.constants';

/**
 * The most orders one reconcile run examines before leaving the rest to the
 * next interval.
 *
 * Small on purpose, and smaller than a retention sweep's batch: in a healthy
 * system this finds **nothing**, so the number is not a throughput knob but a
 * ceiling on how much work a genuine incident — a flushed Redis, a
 * `QUEUE_PREFIX` changed between deploys — can ask of one worker slot. A
 * thousand orphans are reconciled over a few intervals rather than in one tick
 * that holds the queue.
 */
export const MAX_ORDERS_PER_RECONCILE = 200;

/**
 * Reconciles orders that are still `SEARCHING` with nothing scheduled to end
 * their search (issue #115).
 *
 * [ADR-0025](docs/decisions/ADR-0025-deferred-work-on-bullmq.md) § Trade-offs
 * accepted names the hole this fills and assigns it here: *"a lost Redis now
 * means lost deadlines, and an order whose give-up job vanished sits in
 * `SEARCHING` until something re-drives it."* The engine schedules every wave
 * and the deadline the moment an order enters `SEARCHING`, and every one of
 * those jobs is durable — what it cannot do is notice that they are gone. Two
 * ways they can be:
 *
 * 1. **Redis lost them** — a flush, an eviction, a restart without
 *    persistence, or a `QUEUE_PREFIX` change between deploys.
 * 2. **They were never enqueued** — `OrderDispatchRegistry.started` logs and
 *    returns when scheduling throws, because the order is already committed as
 *    `SEARCHING` and failing the customer's request for an order that
 *    genuinely exists would be worse.
 *
 * In both cases the order is `SEARCHING`, nothing is broadcasting it, and
 * nothing will ever end its search: the indefinite spinner EPIC 7 exists to
 * prevent.
 *
 * ## Why this is a queued job and not `@nestjs/schedule`
 *
 * ADR-0025 rejected a `@nestjs/schedule` sweep over `SEARCHING` orders as the
 * **primary** dispatch mechanism, and that argument has to be answered rather
 * than stepped around. It was: every replica runs every tick, so the defence
 * against N replicas acting on one order is a distributed lock — a queue built
 * worse. It still stands, and it is why this is not a `@nestjs/schedule` cron
 * either.
 *
 * This rides on {@link RecurringWorkService} instead, which is the same BullMQ
 * the ADR chose. The scheduler is an upsert keyed by job name, so N replicas
 * calling it leave exactly one scheduler behind, and each iteration it
 * produces is one ordinary queued job that exactly one worker in the fleet
 * runs. There is no second copy of the reconciler to be safe about, no leader
 * election, and no lock — CLAUDE.md §12's "no in-process state two instances
 * would disagree about" holds by construction. Two of them racing anyway would
 * still produce one outcome per order, because the write below is the same
 * conditional `UPDATE` every dispatch tick uses.
 *
 * What the ADR's objection *does* still buy is the shape: this runs rarely and
 * does nothing in the normal case, which is what makes a periodic scan
 * acceptable here and unacceptable as the engine's primary mechanism.
 *
 * **On the `maintenance` queue rather than the `dispatch` one**, for the
 * reason that queue exists: a dispatch tick has an SLA measured in seconds
 * with a customer watching it, and this scans a table. Sharing one concurrency
 * budget would let an incident-sized reconcile delay live waves.
 *
 * ## What it does when it finds one
 *
 * It ends the search as `NO_MASTER_FOUND` — the outcome the give-up tick would
 * have produced had it survived — rather than re-driving it. Re-driving is the
 * alternative the issue leaves open, and it is degenerate here: a candidate is
 * by definition already past `DISPATCH_TOTAL_TIMEOUT_SECONDS`, and
 * `DispatchService.startSearch` derives every delay from the order's own
 * searching-since timestamp, so every wave would fire at once and the fresh
 * give-up would fire with them. That is an expensive route to the same
 * terminal state, and on the way it would mint offers on a search whose window
 * has closed. Giving the customer another real search is a **re-dispatch**,
 * which is EPIC 8's and the customer's decision rather than a reconciler's.
 *
 * ## What it must not do
 *
 * Touch a healthy order. A search whose give-up job is still delayed, waiting
 * or running is left entirely alone — no wave scheduled, no offer written,
 * nothing cancelled. That is checked per candidate, by id, which is possible
 * only because the engine's job ids are deterministic
 * (`dispatch.constants.ts`).
 */
@Injectable()
export class DispatchReconciler implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(DispatchReconciler.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly deferredWork: DeferredWorkService,
    private readonly recurring: RecurringWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Registered in `onModuleInit` rather than at bootstrap, so the handler
   * exists before any worker starts fetching. The registry throws on a
   * duplicate name, which turns "two modules both think they own this job"
   * into a boot failure instead of import-order-dependent behaviour.
   */
  onModuleInit(): void {
    this.handlers.register(DISPATCH_RECONCILE_JOB, () => this.reconcile());
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.dispatch.reconcileIntervalSeconds;

    if (seconds === 0) {
      // Zero has to mean "make sure there is nothing registered", not merely
      // "do not register": a scheduler left behind by an earlier release keeps
      // producing jobs after the flag is turned off. `stop` on a scheduler
      // that was never created is a no-op.
      await this.recurring.stop(DISPATCH_RECONCILE_JOB);
      this.logger.log(
        'DISPATCH_RECONCILE_INTERVAL_SECONDS=0 — orphaned searches are not reconciled',
      );
      return;
    }

    await this.recurring.every(DISPATCH_RECONCILE_JOB, seconds * 1000);
  }

  /**
   * One pass: find the orders whose search window closed long enough ago, keep
   * the ones with nothing scheduled, and end those.
   *
   * **The cutoff is the search deadline plus the grace**, derived from the two
   * rather than configured as one number, so an operator who lengthens the
   * search window does not silently teach the reconciler to fire during it.
   *
   * Idempotent, like every job on this queue: a second pass recomputes the
   * cutoff from a later clock, finds whatever has since gone stale, and cannot
   * find what it already ended — those orders are no longer `SEARCHING`.
   */
  private async reconcile(): Promise<void> {
    const { totalTimeoutSeconds, reconcileGraceSeconds } = this.config.dispatch;
    const cutoff = new Date(Date.now() - (totalTimeoutSeconds + reconcileGraceSeconds) * 1000);

    const candidates = await this.orders.listStaleSearching({
      cutoff,
      limit: MAX_ORDERS_PER_RECONCILE,
    });

    if (candidates.length === 0) {
      // The normal outcome, and deliberately silent: a line every interval
      // saying nothing happened is a line nobody reads, and the whole value of
      // the ones below is that they are rare.
      return;
    }

    let orphaned = 0;
    let ended = 0;

    for (const candidate of candidates) {
      const scheduled = await this.deferredWork.isScheduled(
        dispatchGiveUpJobId(candidate.orderId, candidate.searchingSince.getTime()),
      );

      if (scheduled) {
        /**
         * Late, not orphaned. The deadline is still coming — a worker behind
         * on its queue, or a tick part-way through its retry backoff — and
         * ending the search now would take the order away from a master who
         * may still be about to accept it.
         */
        continue;
      }

      orphaned += 1;

      /**
       * The same two guards `DispatchService.giveUp` uses, for the same
       * reasons. `assertOrderTransition` is the only thing that knows
       * `SEARCHING -> NO_MASTER_FOUND` is a legal edge driven by `system`
       * (ADR-0015); `claimNoMasterFound` is a conditional `UPDATE` matching on
       * both the status and the search's own start time, so a give-up tick
       * arriving at the same moment, a master accepting, and a second
       * reconciler all resolve to exactly one winner — and every loser writes
       * nothing.
       */
      assertOrderTransition('SEARCHING', 'NO_MASTER_FOUND', { kind: 'system' });

      if (await this.orders.claimNoMasterFound(candidate.orderId, candidate.searchingSince)) {
        ended += 1;
      }
    }

    if (orphaned > 0) {
      /**
       * Loud, and at `warn`. A reconciler that quietly fixes things hides the
       * fault it exists to reveal: every line here means a deadline was lost,
       * which is an incident about Redis or about a deploy rather than routine
       * housekeeping. The counts are what make it countable — how many were
       * orphaned, and how many this replica actually ended, which differ
       * exactly when something else won the race.
       */
      this.logger.warn(
        `Reconciled ${String(orphaned)} of ${String(
          candidates.length,
        )} stale searching order(s) with no scheduled deadline; ${String(
          ended,
        )} ended as NO_MASTER_FOUND`,
      );
    }
  }
}
