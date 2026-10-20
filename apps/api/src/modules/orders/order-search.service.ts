import { Inject, Injectable } from '@nestjs/common';
import type { OrderSearchProgress } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { AddressesService } from '../addresses/addresses.service';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import {
  currentDispatchRadiusM,
  dispatchDeadline,
  dispatchRoundAtElapsed,
} from '../dispatch/dispatch-schedule';
import { OrderSearchRepository } from './order-search.repository';
import { OrdersRepository } from './orders.repository';

/**
 * The order exists, is the caller's, and has stopped searching.
 *
 * 409 rather than 404: the caller may read this order, it is the state that
 * makes this read meaningless. The app treats it as "the order moved on" and
 * lets the order's own refetch swap the radar for whatever comes next
 * (ADR-0055 § 5).
 */
export class OrderNotSearchingError extends AppError {
  constructor() {
    super(ERROR_CODES.ORDER_NOT_SEARCHING, 'This order is no longer searching.', 409);
    this.name = 'OrderNotSearchingError';
    Object.setPrototypeOf(this, OrderNotSearchingError.prototype);
  }
}

/**
 * The search radar's read (issue #397,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)).
 *
 * **The first surface that shows somebody who is not a party to an order
 * anything derived from a master's position**, so the three gates are in
 * order and none is skipped: the caller's own customer profile, this order
 * being theirs (404 otherwise, never 403), and the order still `SEARCHING`
 * (409 otherwise). Only then is a cell computed.
 *
 * Everything time-shaped is derived from the clock and the order's
 * `searching_since` with the functions the engine broadcasts by, so the ring
 * and the broadcast cannot disagree and two replicas answer alike.
 */
@Injectable()
export class OrderSearchService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly search: OrderSearchRepository,
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getProgress(actor: Actor, orderId: string): Promise<OrderSearchProgress> {
    const customer = await this.customers.getOwn(actor);
    const found = await this.orders.findByIdForCustomer(orderId, customer.id);
    if (found === undefined) {
      throw new NotFoundError();
    }
    if (found.order.status !== 'SEARCHING') {
      throw new OrderNotSearchingError();
    }

    const state = await this.orders.findDispatchState(orderId);
    // Re-checked on the second read: the order may have been accepted between
    // the two, and a search with no generation has nothing to show.
    if (state?.status !== 'SEARCHING' || state.searchingSince === null) {
      throw new OrderNotSearchingError();
    }

    const origin = await this.addresses.getDispatchOrigin(found.order.addressId);
    if (origin === undefined) {
      // `orders.address_id` is `on delete restrict`; this is a broken row, and
      // a 404 says nothing about it to the caller that a 500 would.
      throw new NotFoundError();
    }

    const timings = this.config.dispatch;
    const now = new Date();
    const generation = { orderId, searchingSince: state.searchingSince };

    const [offeredCount, cells] = await Promise.all([
      this.search.countReached(generation),
      this.search.reachedCells(generation, origin, timings.maxPositionAgeSeconds),
    ]);

    return {
      round: dispatchRoundAtElapsed(now.getTime() - state.searchingSince.getTime(), timings),
      radiusM: currentDispatchRadiusM(state.searchingSince, now, timings),
      maxRadiusM: timings.maxRadiusM,
      endsAt: dispatchDeadline(state.searchingSince, timings).toISOString(),
      offeredCount,
      cells,
    };
  }
}
