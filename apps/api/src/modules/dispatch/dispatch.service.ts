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
  dispatchDeadline,
  dispatchRadiusForRound,
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
 * ## Every tick is idempotent, and every tick guards on the database
 *
 * At-least-once delivery is the contract BullMQ offers, so "this ran twice" is
 * ordinary rather than exceptional. Three mechanisms make it harmless, and
 * none of them is a lock:
 *
 * 1. **Deterministic job ids** (`dispatch.constants.ts`) collapse a double
 *    enqueue into one job before it is ever delivered.
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
    this.dispatchRegistry.register((orderId) => this.startSearch(orderId));
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
   * Drops the rest of a search's schedule — for the accept path (#101) and for
   * re-dispatch (EPIC 8).
   *
   * **Cancellation is an optimisation, never the correctness mechanism.**
   * `DeferredWorkService.cancel` cannot remove a job that is already running,
   * and a replica can die between the accept and this call. Every tick
   * therefore guards on the database whether or not this ever runs, which is
   * why this returns nothing worth checking.
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
    const radiusM = dispatchRadiusForRound(round, this.timings);

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

    const claimed = await this.orders.claimNoMasterFound(orderId, new Date(searchingSinceMs));

    if (!claimed) {
      // The ordinary late tick: a master accepted, or the customer cancelled,
      // or a re-dispatch started a newer search. Zero rows, nothing written.
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
      return null;
    }

    if (state.searchingSince.getTime() !== searchingSinceMs) {
      this.logger.debug(`A tick from an earlier search on order ${orderId} was ignored`);
      return null;
    }

    return state;
  }
}
