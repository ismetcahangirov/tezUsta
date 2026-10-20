import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { REDIS_CLIENT } from '../../infra/redis/redis.tokens';
import { CustomersService } from '../customers/customers.service';
import { MasterLocationRegistry } from '../masters/master-location.registry';
import type { MasterPositionReported } from '../masters/master-location.registry';
import { OrdersRepository } from '../orders/orders.repository';
import { NotificationsService } from './notifications.service';

/** How long an assignment's "sent" mark is kept. Far longer than any trip. */
const SENT_MARK_TTL_SECONDS = 2 * 24 * 60 * 60;

/** The once-per-assignment mark: one key per order and accept. */
export function masterNearbyKey(keyPrefix: string, orderId: string, acceptedAtMs: number): string {
  return `${keyPrefix}:notifications:master-nearby:${orderId}:${String(acceptedAtMs)}`;
}

/**
 * "Your master is nearby" (issue #414): one push to the customer, the first
 * time the master on the way reports a point within `MASTER_NEARBY_RADIUS_M`
 * of the order's address.
 *
 * **From the position path, but not a cost on it.** It listens on
 * `MasterLocationRegistry` beside the map fan-out and runs alongside it. A
 * report costs one probe of `orders_one_active_per_master`, filtered to
 * `MASTER_ON_THE_WAY` and to the radius by `ST_DWithin` in the same
 * statement. Only a hit goes further, and the push itself is enqueued like
 * every other one (`NotificationsService.notify`), never sent inline.
 *
 * **Once per assignment, guarded in Redis** by `SET NX` on a key naming the
 * order and its accept time. Redis rather than a column, because:
 * - the guard is atomic across API instances without a write to `orders` on
 *   the hottest path;
 * - a re-dispatch is a new accept time, so a new key, and the next master
 *   gets their own push with nothing to reset;
 * - the key expires on its own.
 * What a lost Redis costs is at worst a second "nearby" push for a trip in
 * progress — a nuisance, not a wrong state — which is the trade this guard
 * accepts.
 *
 * `MASTER_ARRIVED` or any later status ends it, because the query asks only
 * for `MASTER_ON_THE_WAY`. Preferences are respected where every push's are:
 * at delivery, under the `order-progress` category.
 *
 * No coordinate and no distance reaches the payload or a log line.
 */
@Injectable()
export class MasterNearbyNotifier implements OnModuleInit {
  constructor(
    private readonly registry: MasterLocationRegistry,
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register('master-nearby', (event) => this.onReported(event));
  }

  async onReported(event: MasterPositionReported): Promise<void> {
    const order = await this.orders.findOnTheWayOrderNear(
      event.masterId,
      { latitude: event.latitude, longitude: event.longitude },
      this.config.notifications.masterNearbyRadiusM,
    );
    if (order === undefined) {
      return;
    }

    const key = masterNearbyKey(this.config.redis.keyPrefix, order.orderId, order.acceptedAtMs);
    const claimed = await this.redis.set(key, '1', 'EX', SENT_MARK_TTL_SECONDS, 'NX');
    if (claimed !== 'OK') {
      return;
    }

    const userId = await this.customers.findUserId(order.customerId);
    if (userId === undefined) {
      return;
    }
    await this.notifications.notify({
      userId,
      kind: 'master-nearby',
      orderId: order.orderId,
      orderStatus: 'MASTER_ON_THE_WAY',
    });
  }
}
