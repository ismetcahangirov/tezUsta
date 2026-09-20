import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../../infra/queue/deferred-work.service';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { AddressesService } from '../addresses/addresses.service';
import { NearbyMastersService } from '../masters/nearby-masters.service';
import { OrderDispatchRegistry } from '../orders/order-dispatch.registry';
import { assertOrderTransition } from '../orders/order-lifecycle';
import { OrderOffersRepository } from '../orders/order-offers.repository';
import { OrdersRepository } from '../orders/orders.repository';
import type { OrderDispatchState } from '../orders/orders.repository';
import {
  DISPATCH_GIVE_UP_JOB,
  DISPATCH_WAVE_JOB,
  dispatchGiveUpJobId,
  dispatchWaveJobId,
} from './dispatch.constants';
import { dispatchGiveUpPayloadSchema, dispatchWavePayloadSchema } from './dispatch.schema';
import type { DispatchTimings } from './dispatch-schedule';
import {
  currentDispatchRadiusM,
  dispatchDeadline,
  dispatchRoundAtElapsed,
  dispatchWaveCount,
  dispatchWavePlan,
  offerExpiresAt,
} from './dispatch-schedule';

/**
 * The dispatch engine (issue #103): an order that enters `SEARCHING` is
 * broadcast to every eligible master in range, the radius widens when nobody
 * takes it, offers expire, and the search ends in `NO_MASTER_FOUND` rather
 * than spinning forever ([ADR-0009](docs/decisions/ADR-0009-dispatch-model.md),
 * [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md)).
 *
 * ## It holds no state of its own
 *
 * Nothing that survives a tick lives in this object. A wave re-reads the
 * order, re-derives its round from the clock and the order's searching-since
 * timestamp, and writes through guards the database evaluates — so two API
 * replicas running the engine produce one set of offers and one give-up, not
 * two (CLAUDE.md §12). The only thing carried between ticks is the job
 * payload, and that is two ids and an integer.
 *
 * **The wave plan itself is derived per replica, from that replica's own
 * environment.** "The round comes from the clock" makes two replicas agree
 * only while the four `DISPATCH_*` parameters are identical across them: the
 * wave count, the radii and the job ids are all functions of those four
 * numbers, so a rolling deploy that changes one has the old and new replicas
 * scheduling different numbers of waves under different ids for the same
 * in-flight search. The guards keep the result correct — no duplicate offers,
 * one terminal transition — but the search's *shape* is whichever replica
 * scheduled it. Change a dispatch parameter the way a schema is changed, not
 * the way a feature flag is.
 *
 * ## Every tick is idempotent, and every tick guards on the database
 *
 * At-least-once delivery is the contract BullMQ offers, so "this ran twice" is
 * ordinary rather than exceptional. Three mechanisms make it harmless, and
 * none of them is a lock:
 *
 * 1. **Deterministic job ids** (`dispatch.constants.ts`) collapse a double
 *    enqueue into one job before it is ever delivered — *while the job still
 *    exists*. `DeferredWorkService` keeps only the last hundred completed
 *    jobs (`removeOnComplete: { count: 100 }`), so roughly fourteen orders'
 *    worth of ticks later the id is free again and a replayed `POST /orders`
 *    re-schedules the whole plan: the waves already past get `delayMs = 0`
 *    and fire at once. Correctness survives on mechanisms 2 and 3 — every
 *    one of those ticks finds live offers and writes nothing — so what is
 *    actually spent is one `findDispatchState` read per replayed wave, plus
 *    an eligibility query for each wave still inside the search window
 *    (`runWave` returns before that query once the deadline has passed).
 *    Bounded by the wave count, which is six. Guarding it would mean keeping
 *    a marker of "this search is already scheduled" somewhere outside the job
 *    itself, which is the in-process state §12 exists to refuse, in exchange
 *    for at most six indexed reads on an order nobody is waiting on.
 * 2. **The offer upsert** re-offers only a row that is expired, run out, or
 *    `lost`, so a duplicate wave updates nothing and writes no second row —
 *    the unique index on `(order_id, master_id)` makes a second row
 *    impossible anyway (`order-offers.repository.ts`).
 * 3. **The terminal transition is a conditional `UPDATE`** matching on
 *    `status = 'SEARCHING'` and on the search's own start time
 *    (`OrdersRepository.claimNoMasterFound`), so a tick that arrives after a
 *    master accepted writes zero rows and exits clean.
 *
 * ## What it deliberately does not do
 *
 * It builds **no HTTP surface**. The master's offer feed, decline and accept
 * are issue #101's. Re-dispatch is EPIC 8's: the engine is re-entrant through
 * {@link OrderDispatchRegistry}, so a fresh dispatch is started by
 * transitioning an order back to `SEARCHING` and announcing it, never by
 * calling into this class.
 *
 * And it tells nobody anything. ADR-0009 requires losing masters to be told
 * **immediately** that an order is gone; the realtime channel that would carry
 * that is EPIC 9 and does not exist. What this engine owes meanwhile is that
 * the state is correct and immediately readable — an offer stops being live
 * the moment its order stops searching, because the feed's predicate is a
 * `WHERE` and not a cached notification.
 */
@Injectable()
export class DispatchService implements OnModuleInit {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly offers: OrderOffersRepository,
    private readonly addresses: AddressesService,
    private readonly nearby: NearbyMastersService,
    private readonly deferredWork: DeferredWorkService,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly dispatchRegistry: OrderDispatchRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.handlers.register(DISPATCH_WAVE_JOB, (payload) => this.runWave(payload));
    this.handlers.register(DISPATCH_GIVE_UP_JOB, (payload) => this.giveUp(payload));
    this.dispatchRegistry.register(
      (orderId) => this.startSearch(orderId),
      (orderId) => this.endSearch(orderId),
    );
  }

  private get timings(): DispatchTimings {
    // Read through, never copied into a field: the config object is frozen and
    // a literal here would be exactly what ADR-0009 forbids.
    return this.config.dispatch;
  }

  /**
   * Schedules the whole of one order's search: every broadcast wave, and the
   * deadline that ends it.
   *
   * **All of it up front, rather than each wave chaining the next.** A chain
   * has one failure mode this does not: a tick whose handler exhausts its
   * retries takes every later wave with it, and the order then searches in
   * silence until the give-up fires. Scheduling the plan means a lost wave
   * costs one round, not the rest of the search. The cost is bounded and
   * small — six waves and a deadline per order with the shipped parameters,
   * against the ~120 jobs a per-offer expiry would have cost.
   *
   * Delays are computed from the order's own searching-since timestamp rather
   * than from "now", so a schedule written late — a slow request, a retry, a
   * second replica — still lands on the clock the order actually started on.
   *
   * Safe to call twice: the job ids are derived from the order and that same
   * timestamp, and `DeferredWorkService.schedule` collapses a repeat into the
   * job that already exists.
   */
  async startSearch(orderId: string): Promise<void> {
    const state = await this.orders.findDispatchState(orderId);

    if (state === undefined || state.status !== 'SEARCHING' || state.searchingSince === null) {
      // Not an error: an order cancelled between the transition and this call
      // is a race the customer won, and there is nothing to dispatch.
      this.logger.debug(`Order ${orderId} is not searching; nothing scheduled`);
      return;
    }

    const searchingSince = state.searchingSince;
    const searchingSinceMs = searchingSince.getTime();

    for (const wave of dispatchWavePlan(this.timings)) {
      await this.deferredWork.schedule(
        DISPATCH_WAVE_JOB,
        { orderId, searchingSinceMs, round: wave.round },
        {
          delayMs: Math.max(0, searchingSinceMs + wave.offsetMs - Date.now()),
          jobId: dispatchWaveJobId(orderId, searchingSinceMs, wave.round),
        },
      );
    }

    await this.deferredWork.schedule(
      DISPATCH_GIVE_UP_JOB,
      { orderId, searchingSinceMs },
      {
        delayMs: Math.max(0, dispatchDeadline(searchingSince, this.timings).getTime() - Date.now()),
        jobId: dispatchGiveUpJobId(orderId, searchingSinceMs),
      },
    );
  }

  /**
   * An order has stopped searching; drop what is left of its schedule
   * (issue #120).
   *
   * **The slot the accept path fills**, through `OrderDispatchRegistry` rather
   * than by importing this module — `MasterOffersModule` importing
   * `DispatchModule` would be a second edge into an engine that already
   * depends on orders, and the registry exists precisely so that arrow keeps
   * pointing one way.
   *
   * **Eager, rather than letting the next tick notice.** Both routes end up in
   * the same place — {@link closeOutEndedSearch} cancels the schedule too, and
   * is still the backstop for a replica that died between the accept and this
   * call — but waiting for a tick means running the waves this exists to
   * avoid. With the shipped parameters an accept ten seconds into a
   * three-minute window leaves five broadcasts, each taking a `FOR SHARE` lock
   * and running a PostGIS eligibility query to write nothing (CLAUDE.md §12).
   *
   * The generation is read here rather than passed in, so no caller has to
   * know that a dispatch schedule is keyed by when the order entered
   * `SEARCHING`. It is one indexed read of the order's own audit trail, and it
   * is still correct after the transition: `searchingSinceOf` asks for the
   * last `SEARCHING` the trail records, which is the search that just ended.
   */
  private async endSearch(orderId: string): Promise<void> {
    const state = await this.orders.findDispatchState(orderId);

    if (state === undefined || state.searchingSince === null) {
      // An order that never searched has no schedule. Not an error: EPIC 8
      // will end orders that were never dispatched at all.
      return;
    }

    if (state.status === 'SEARCHING') {
      /**
       * A re-dispatch (EPIC 8) has already put the order back out, between the
       * transition that ended the previous search and this call. Cancelling
       * now would take out the **new** search's jobs, and the generation read
       * above is the new one — so the old search's jobs would survive and the
       * live one would be silently unscheduled. The old ticks are harmless on
       * their own; that would not be.
       */
      this.logger.debug(`Order ${orderId} is searching again; its schedule was left alone`);
      return;
    }

    await this.cancelSearch(orderId, state.searchingSince);
  }

  /**
   * Drops the rest of a search's schedule.
   *
   * **Cancellation is an optimisation, never the correctness mechanism.**
   * `DeferredWorkService.cancel` cannot remove a job that is already running,
   * a replica can die between the accept and this call, and BullMQ's
   * `removeOnComplete: { count: 100 }` frees a job id as the job is evicted —
   * so an id this looks for may belong to nothing, or to a *replay* of the
   * same schedule enqueued after the eviction. Every tick therefore guards on
   * the database whether or not this ever runs, which is why this returns
   * nothing worth checking. "The schedule is gone" is not a claim this can
   * make; "the schedule has been asked to go" is.
   *
   * Two callers, and they are not alternatives. {@link endSearch} is the eager
   * one, reached the moment a master wins. {@link closeOutEndedSearch} is the
   * backstop, for every exit this engine only finds out about on its next
   * tick.
   */
  async cancelSearch(orderId: string, searchingSince: Date): Promise<void> {
    const searchingSinceMs = searchingSince.getTime();

    for (let round = 1; round <= dispatchWaveCount(this.timings); round += 1) {
      await this.deferredWork.cancel(dispatchWaveJobId(orderId, searchingSinceMs, round));
    }
    await this.deferredWork.cancel(dispatchGiveUpJobId(orderId, searchingSinceMs));
  }

  /**
   * One broadcast round.
   *
   * The round it broadcasts at comes from the **clock**, not from the payload:
   * a tick delayed by a busy worker must widen to where the search really is,
   * or a master already inside the current radius would be skipped because a
   * queue was slow (`dispatch-schedule.ts`).
   *
   * **A wave that finds nobody is normal, not an error.** It is the expected
   * outcome in a thin coverage area at 03:00, and logging it at error level
   * would page somebody for an ordinary Tuesday. Nothing here logs a
   * coordinate or an address, at any level (CLAUDE.md §11) — the order id and
   * a count are the whole of it.
   *
   * **A known and accepted cost:** `findEligible` answers with the nearest
   * masters who could take the job, and it does not know which of them already
   * declined *this* order — decline is a fact about an offer, and the
   * eligibility query is deliberately about a master (issue #100). So a master
   * who declined can still occupy one of the
   * `DISPATCH_MAX_MASTERS_PER_BROADCAST` slots in a later round, and the
   * broadcast is that much smaller. The rule itself still holds — the upsert
   * refuses to touch their row, so they are never re-offered — and the log
   * line reports offered-of-eligible rather than just the cap, so the gap is
   * visible rather than silent. Teaching the eligibility query about offers
   * would couple it to the order it is being run for; it is worth doing only
   * if the measured decline rate makes the lost slots matter (#114).
   */
  private async runWave(payload: DeferredJobPayload): Promise<void> {
    const {
      orderId,
      searchingSinceMs,
      round: scheduledRound,
    } = dispatchWavePayloadSchema.parse(payload);

    const state = await this.searchInProgress(orderId, searchingSinceMs);
    if (state === null) {
      return;
    }

    const now = new Date();
    const searchingSince = new Date(searchingSinceMs);

    if (now.getTime() >= dispatchDeadline(searchingSince, this.timings).getTime()) {
      // Past the deadline the give-up tick owns the order, and a broadcast now
      // would mint offers on a search that is over.
      this.logger.debug(
        `Wave ${String(scheduledRound)} for order ${orderId} arrived past the deadline; skipped`,
      );
      return;
    }

    const round = dispatchRoundAtElapsed(now.getTime() - searchingSince.getTime(), this.timings);
    // The same function the read path is meant to bound itself by, called
    // here so the engine and any reader derive the radius from one expression
    // rather than from two that have to be kept in step (issue #103).
    const radiusM = currentDispatchRadiusM(searchingSince, now, this.timings);

    const origin = await this.addresses.getDispatchOrigin(state.addressId);
    if (origin === undefined) {
      // Thrown rather than returned: an order references its address with
      // `onDelete: 'restrict'`, so this cannot happen without something being
      // badly wrong, and a retry is the honest response to "badly wrong".
      throw new Error(`Order ${orderId} has no dispatchable address`);
    }

    const candidates = await this.nearby.findEligible({
      serviceId: state.serviceId,
      latitude: origin.latitude,
      longitude: origin.longitude,
      radiusM,
    });

    if (candidates.length === 0) {
      this.logger.log(
        `Order ${orderId}: round ${String(round)} at ${String(radiusM)}m reached nobody`,
      );
      return;
    }

    const offered = await this.offers.broadcast({
      orderId,
      searchingSince,
      round,
      radiusM,
      expiresAt: offerExpiresAt(now, searchingSince, this.timings),
      candidates: candidates.map((candidate) => ({
        masterId: candidate.masterId,
        distanceM: candidate.distanceM,
      })),
    });

    this.logger.log(
      `Order ${orderId}: round ${String(round)} at ${String(radiusM)}m offered to ${String(
        offered.length,
      )} of ${String(candidates.length)} eligible masters`,
    );
  }

  /**
   * The deadline: nobody accepted, so the order stops searching.
   *
   * `NO_MASTER_FOUND` is terminal and is **not** a cancellation by anyone
   * (ADR-0015) — actor kind `system`, with no actor id, written to
   * `order_status_history` in the same transaction as the status change, along
   * with the order's remaining live offers. A cancellation-rate metric that
   * counted this would be measuring supply and calling it behaviour.
   */
  private async giveUp(payload: DeferredJobPayload): Promise<void> {
    const { orderId, searchingSinceMs } = dispatchGiveUpPayloadSchema.parse(payload);

    const state = await this.searchInProgress(orderId, searchingSinceMs);
    if (state === null) {
      return;
    }

    /**
     * **The transition table decides whether this edge exists; the `WHERE`
     * decides whether this tick wins it.** Both, for the reason #101's accept
     * gives for calling both: the conditional `UPDATE` settles a race between
     * two writers, and it settles it by matching on two string literals — it
     * cannot tell anyone that `SEARCHING -> NO_MASTER_FOUND` is a legal edge
     * driven by `system`, only that the row still says `SEARCHING`. With the
     * assertion skipped here, `order-lifecycle.ts` would stop being the only
     * thing that knows the edges, which is the one property that file claims
     * (ADR-0015).
     *
     * It throws rather than returning false, and that is right for a job: the
     * edge either exists in the table or the table has been changed out from
     * under an engine that still believes in it, and a tick that quietly did
     * nothing would hide that until an order sat `SEARCHING` forever.
     */
    assertOrderTransition(state.status, 'NO_MASTER_FOUND', { kind: 'system' });

    const claimed = await this.orders.claimNoMasterFound(orderId, new Date(searchingSinceMs));

    if (!claimed) {
      // The ordinary late tick: a master accepted, or the customer cancelled,
      // or a re-dispatch started a newer search, between the read above and
      // the write. Zero rows, nothing written.
      this.logger.debug(`Order ${orderId} was no longer searching at its deadline; nothing to do`);
      return;
    }

    this.logger.log(`Order ${orderId}: no master found within the search window`);
  }

  /**
   * The state a tick may act on, or `null` when it may not.
   *
   * Both refusals are ordinary. The order may have been accepted or cancelled
   * since the job was scheduled — the common case, and the reason every write
   * below is still guarded in SQL rather than by this read. Or the job may
   * belong to an **earlier** search on the same order, which EPIC 8's
   * re-dispatch makes possible: the order is `SEARCHING` again, but on a
   * different clock, and a stale tick that acted would widen and give up on
   * the wrong schedule.
   */
  private async searchInProgress(
    orderId: string,
    searchingSinceMs: number,
  ): Promise<OrderDispatchState | null> {
    const state = await this.orders.findDispatchState(orderId);

    if (state === undefined || state.status !== 'SEARCHING' || state.searchingSince === null) {
      this.logger.debug(`Order ${orderId} is no longer searching; tick did nothing`);
      if (state !== undefined) {
        await this.closeOutEndedSearch(orderId, searchingSinceMs);
      }
      return null;
    }

    if (state.searchingSince.getTime() !== searchingSinceMs) {
      /**
       * **Not a close-out.** The order is searching, on a newer clock: this
       * tick belongs to the search that was replaced. Expiring "the live
       * offers" here would expire the *new* search's offers, and cancelling
       * "the schedule" would cancel jobs that do not belong to this
       * generation anyway. Exit, touch nothing.
       */
      this.logger.debug(`A tick from an earlier search on order ${orderId} was ignored`);
      return null;
    }

    return state;
  }

  /**
   * The search is over and something else ended it — an accept, a
   * cancellation, a re-dispatch that has since ended too. Close it out.
   *
   * **This is the backstop, not the route.** Every exit that exists closes out
   * in the transaction that ends the search, which is the only way to keep a
   * terminal order and a live offer on it from both being readable:
   * `claimNoMasterFound` expires its own offers, and #101's accept marks the
   * losing ones `lost` and cancels the schedule eagerly through
   * {@link endSearch}. What is left for this is the exit nothing announced —
   * EPIC 8's cancel, which has no endpoint yet, and the replica that died
   * between a transition and its announcement — noticed the way the engine
   * notices everything else: on its next tick, at most one round later.
   *
   * Both halves are idempotent, and neither is what makes a late tick safe —
   * the guards in SQL are. Expiring already-closed offers matches zero rows;
   * cancelling an absent or already-running job returns false.
   */
  private async closeOutEndedSearch(orderId: string, searchingSinceMs: number): Promise<void> {
    const closed = await this.offers.expireLiveOffers(orderId);
    if (closed > 0) {
      this.logger.log(
        `Order ${orderId}: closed out ${String(closed)} offer(s) left live by an ended search`,
      );
    }

    await this.cancelSearch(orderId, new Date(searchingSinceMs));
  }
}
