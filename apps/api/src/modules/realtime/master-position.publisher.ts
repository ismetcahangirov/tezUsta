import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { MasterPositionRealtimeEvent } from '@tezusta/types';
import type Redis from 'ioredis';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { REDIS_CLIENT } from '../../infra/redis/redis.tokens';
import { MasterLocationRegistry } from '../masters/master-location.registry';
import type { MasterPositionReported } from '../masters/master-location.registry';
import { OrdersRepository } from '../orders/orders.repository';
import { MASTER_POSITION_EVENT } from './realtime.events';
import { RealtimeGateway } from './realtime.gateway';
import { orderRoom } from './room.types';

/**
 * The Redis key one order's fan-out window lives under.
 *
 * Namespaced under `REDIS_KEY_PREFIX` for the reason `presenceKey` gives: two
 * checkouts sharing one Redis must not share one another's windows. The value
 * is a single byte — what matters is that the key exists and when it expires.
 *
 * **No coordinate is ever written to Redis** (CLAUDE.md §11). The window is a
 * gate, not a buffer; the position it admits goes straight to the room.
 *
 * Exported so a test can assert against the same key shape rather than
 * re-spelling it.
 */
export function positionFanoutKey(keyPrefix: string, orderId: string): string {
  return `${keyPrefix}:realtime:position-window:${orderId}`;
}

/**
 * A master's position reaching the one customer entitled to see it, and nobody
 * else, ever (issue #169).
 *
 * **One sentence is the whole security surface**: a master's live position is
 * visible to the customer on the active order, and only while that order is
 * active (CLAUDE.md §11). Everything below exists to make exactly that true.
 *
 * - The destination is resolved from the **database**, per report, as
 *   `orders.master_id` stands — never from anything the reporting client sent
 *   and never from a cached assignment.
 * - A master with no engaged order publishes nothing. Their report still lands
 *   in `master_locations` and still feeds dispatch.
 * - A terminal status and a re-dispatch both leave the set the lookup asks for,
 *   so the next report resolves to nothing. And #167's eviction has already
 *   emptied the room on the transition itself, so even a report racing the
 *   transition reaches an empty room rather than the wrong person.
 *
 * **Nothing here logs a coordinate at any level.** The latitude and longitude
 * reach exactly two places: the event that raised them, and the socket frame.
 */
@Injectable()
export class MasterPositionPublisher implements OnModuleInit {
  private readonly logger = new Logger(MasterPositionPublisher.name);

  constructor(
    private readonly registry: MasterLocationRegistry,
    private readonly orders: OrdersRepository,
    private readonly gateway: RealtimeGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register((event) => this.onReported(event));
  }

  /**
   * One recorded position becomes at most one frame in one order's room.
   *
   * **The order lookup runs before the throttle**, which is the more expensive
   * of the two and is deliberately still first: a master with no engaged order
   * is the common case all day, and gating first would put a Redis write on
   * every idle report to answer a question the database answers with an index
   * lookup on a partial unique index that already exists
   * (`orders.repository.ts#findEngagedOrderIdForMaster`).
   */
  private async onReported(event: MasterPositionReported): Promise<void> {
    const orderId = await this.orders.findEngagedOrderIdForMaster(event.masterId);

    if (orderId === undefined) {
      return;
    }

    if (!(await this.openWindow(orderId))) {
      return;
    }

    const payload: MasterPositionRealtimeEvent = {
      orderId,
      latitude: event.latitude,
      longitude: event.longitude,
      at: event.recordedAt.getTime(),
    };

    const server = this.gateway.server as typeof this.gateway.server | undefined;

    if (server === undefined) {
      this.logger.debug('no position published: the socket server is not attached yet');
      return;
    }

    server.to(orderRoom(orderId)).emit(MASTER_POSITION_EVENT, payload);
  }

  /**
   * Whether this report gets to be the one broadcast of its window.
   *
   * **`SET key 1 PX window NX` — in Redis, not in this process**, because two
   * API instances holding their own timers would each publish once per window
   * and the throttle would quietly become "once per window per instance"
   * (CLAUDE.md §12). One key per order, one winner, whichever instance the
   * report landed on.
   *
   * **Leading edge: the report that opens a window is the one broadcast, and
   * the rest of that window is dropped.** The alternative — hold the newest
   * and flush it when the window closes — needs a scheduled job per order per
   * window, and buys nothing: either way the customer receives one point per
   * window, and either way that point is fresh at the instant it is sent. What
   * leading edge costs is the tail, the surplus report that arrives after the
   * last broadcast and is never superseded because reporting stopped. That
   * cannot strand a *moving* master's marker, which is the failure the issue
   * names: ADR-0026 makes the reporting floor 10–15 s while travelling —
   * sent whether or not the phone moved a metre — so every window of a
   * compliant app contains a report, and the marker advances every window for
   * as long as the master is online.
   *
   * A Redis failure throws, `MasterLocationRegistry` swallows it, and the
   * report stands. The position is in the table either way; what is lost is
   * one frame on one map.
   */
  private async openWindow(orderId: string): Promise<boolean> {
    const key = positionFanoutKey(this.config.redis.keyPrefix, orderId);
    const windowMs = this.config.realtime.positionFanoutSeconds * 1_000;

    return (await this.redis.set(key, '1', 'PX', windowMs, 'NX')) === 'OK';
  }
}
