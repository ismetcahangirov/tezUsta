import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import type { ArrivalPromiseSource } from '@tezusta/types';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { estimateDrivingSeconds } from '../../infra/geo/driving-estimate';
import { ROUTING_PROVIDER } from '../../infra/geo/routing.types';
import type { RoutingProvider } from '../../infra/geo/routing.types';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { PermanentJobError } from '../../infra/queue/queue.types';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import { AddressesService } from '../addresses/addresses.service';
import { MasterLocationRepository } from '../masters/master-location.repository';
import {
  ARRIVAL_PROMISE_JOB,
  ARRIVAL_PROMISE_SWEEP_JOB,
  arrivalPromisePayloadSchema,
} from '../orders/arrival-promise.job';
import { ArrivalPromiseRepository } from '../orders/arrival-promise.repository';
import { ArrivalPromiseScheduler } from '../orders/arrival-promise.scheduler';
import { ArrivalPromisesRegistry } from '../orders/arrival-promises.registry';

/** How long an accept may go without a promise before the sweep asks again (ADR-0055 § 10). */
export const ARRIVAL_PROMISE_SWEEP_AFTER_SECONDS = 60;

/** The most accepts one sweep tick re-asks for, so a backlog drains in bounded steps. */
const MAX_PER_SWEEP = 200;

/**
 * The arrival promise (issue #396,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 7–11): one job per accept that fixes `promised_arrival_at`, and the sweep
 * under it.
 *
 * **The formula is `accepted_at + travel + ARRIVAL_PROMISE_BUFFER_SECONDS`**,
 * counted from the accept and never from when this ran, so a slow queue does
 * not hand the master time nobody decided to give them.
 *
 * **Travel comes from a road route when there is one**, from the master's
 * latest fresh position to the order's dispatch origin, and otherwise from the
 * generous straight-line estimate (§ 10): when Routes throws, finds no road,
 * or the master has no fresh position, in which case the distance is the one
 * the accepted offer showed them. The promise is never left unwritten because
 * routing failed.
 *
 * **What it never does**: keep, or log, the route's duration or distance
 * (Google's terms, § 7), or a coordinate (CLAUDE.md § 11). The log line names
 * the order and the source.
 */
@Injectable()
export class ArrivalPromiseService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ArrivalPromiseService.name);

  constructor(
    private readonly promises: ArrivalPromiseRepository,
    private readonly scheduler: ArrivalPromiseScheduler,
    private readonly registry: ArrivalPromisesRegistry,
    private readonly locations: MasterLocationRepository,
    private readonly addresses: AddressesService,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly recurring: RecurringWorkService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.handlers.register(ARRIVAL_PROMISE_JOB, (payload) => this.fix(payload));
    this.handlers.register(ARRIVAL_PROMISE_SWEEP_JOB, () => this.sweep());
  }

  /**
   * The sweep runs on the dispatch reconciler's interval: both are backstops
   * for work an accept or a search scheduled and a dead replica lost, and an
   * operator turning one off (`0`, as the test suites do) means both.
   */
  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.dispatch.reconcileIntervalSeconds;
    if (seconds === 0) {
      await this.recurring.stop(ARRIVAL_PROMISE_SWEEP_JOB);
      return;
    }
    await this.recurring.every(ARRIVAL_PROMISE_SWEEP_JOB, seconds * 1000);
  }

  /**
   * One accept's promise. Exits without writing when the order has moved on —
   * re-dispatched, a different accept, arrived, already promised — and the
   * conditional `UPDATE` makes the same true of a job that raced any of those.
   */
  private async fix(payload: DeferredJobPayload): Promise<void> {
    const { orderId, masterId, acceptedAtMs } = arrivalPromisePayloadSchema.parse(payload);

    const target = await this.promises.findTarget(orderId);
    if (
      target === undefined ||
      (target.status !== 'ACCEPTED' && target.status !== 'MASTER_ON_THE_WAY') ||
      target.masterId !== masterId ||
      target.acceptedAtMs !== acceptedAtMs ||
      target.hasPromise
    ) {
      this.logger.debug(`Order ${orderId}: no arrival promise owed for this accept`);
      return;
    }

    const destination = await this.addresses.getDispatchOrigin(target.addressId);
    if (destination === undefined) {
      // `orders.address_id` is `on delete restrict`; another attempt finds the
      // same broken row.
      throw new PermanentJobError(`Order ${orderId} has no dispatchable address`);
    }

    const travel = await this.travel(orderId, masterId, destination);
    const promisedArrivalAt = new Date(
      acceptedAtMs + (travel.seconds + this.config.orders.arrivalPromiseBufferSeconds) * 1000,
    );

    const written = await this.promises.write({
      orderId,
      masterId,
      acceptedAtMs,
      promisedArrivalAt,
      source: travel.source,
    });
    if (!written) {
      this.logger.debug(`Order ${orderId}: the accept moved on before its promise was written`);
      return;
    }

    this.logger.log(`Order ${orderId}: arrival promised (${travel.source})`);
    await this.registry.promised({ orderId, promisedArrivalAt, source: travel.source });
  }

  private async travel(
    orderId: string,
    masterId: string,
    destination: { latitude: number; longitude: number },
  ): Promise<{ seconds: number; source: ArrivalPromiseSource }> {
    const origin = await this.locations.findFreshPosition(
      masterId,
      this.config.dispatch.maxPositionAgeSeconds,
      destination,
    );

    if (origin !== undefined) {
      try {
        const route = await this.routing.drivingRoute(origin, destination);
        if (route !== null) {
          return { seconds: route.durationSeconds, source: 'route' };
        }
      } catch (error) {
        // The provider's errors carry no key and no coordinate by contract
        // (`google-routes.provider.ts`).
        this.logger.warn(
          `Order ${orderId}: routing did not answer, so the estimate stands in: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { seconds: estimateDrivingSeconds(origin.distanceM), source: 'estimate' };
    }

    const offered = await this.promises.acceptedOfferDistanceM(orderId, masterId);
    if (offered === undefined) {
      // An accepted order whose accepted offer is missing is a broken row.
      throw new PermanentJobError(`Order ${orderId} has no accepted offer for its master`);
    }
    return { seconds: estimateDrivingSeconds(offered), source: 'estimate' };
  }

  /**
   * Re-asks for every accept that has gone a minute without a promise: the
   * replica that died between the commit and the schedule, or a job whose
   * attempts all failed (`ArrivalWorkService` revives it). The job id is the
   * accept's own, so a promise still in flight is not asked for twice.
   */
  private async sweep(): Promise<void> {
    const missing = await this.promises.listMissing({
      acceptedBefore: new Date(Date.now() - ARRIVAL_PROMISE_SWEEP_AFTER_SECONDS * 1000),
      limit: MAX_PER_SWEEP,
    });
    if (missing.length === 0) {
      return;
    }

    for (const accept of missing) {
      await this.scheduler.schedule({
        orderId: accept.orderId,
        masterId: accept.masterId,
        acceptedAt: new Date(accept.acceptedAtMs),
      });
    }
    this.logger.warn(`Re-asked for ${String(missing.length)} missing arrival promise(s)`);
  }
}
