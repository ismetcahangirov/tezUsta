import { Injectable } from '@nestjs/common';
import type { Order } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { OrderRow } from '../../infra/database/schema/orders';
import { AddressesService } from '../addresses/addresses.service';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { ServicesService } from '../services/services.service';
import { assertOrderTransition } from './order-lifecycle';
import { OrdersRepository } from './orders.repository';
import type { CreateOrderRequest } from './orders.schema';

/**
 * The same idempotency key, a different request.
 *
 * Returning the original order would be worse than refusing: the client
 * believes it asked for a tap repair at the office and would be shown a boiler
 * job at home, with nothing anywhere to say the two requests differed. A key
 * is a client's assertion that two requests are the same one, and this is the
 * server noticing that the assertion is false.
 *
 * 409 rather than 422 — the body is well-formed, and it is the state the key
 * already names that makes it unacceptable.
 */
export class OrderIdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'That request key has already been used for a different order.',
      409,
    );
    this.name = 'OrderIdempotencyKeyReusedError';
    Object.setPrototypeOf(this, OrderIdempotencyKeyReusedError.prototype);
  }
}

/**
 * Order creation, scoped to the caller's own customer profile.
 *
 * **No method takes a customer id.** The owner is resolved from the actor, so
 * there is no request shape in which a caller names somebody else's profile —
 * the same rule `AddressesService` follows, and for the same reason.
 *
 * The address and the service are validated **through the modules that own
 * them** rather than by querying their tables: `AddressesService.getById`
 * already answers "is this address the caller's?" with a 404 when it is not,
 * and `ServicesService.getServiceById` already means "exists and is active".
 * Re-deriving either here would be a second answer to a settled question
 * (`docs/architecture/backend-architecture.md` § Module rules).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    private readonly services: ServicesService,
  ) {}

  async create(actor: Actor, input: CreateOrderRequest): Promise<Order> {
    const customer = await this.customers.getOwn(actor);

    // Both throw `NotFoundError` — an address that is not the caller's, and a
    // service that does not exist or is no longer offered, are the same 404.
    await this.addresses.getById(actor, input.addressId);
    // The locale is irrelevant here: nothing in an order response carries a
    // service name, and this call is an existence-and-active check.
    await this.services.getServiceById(input.serviceId, []);

    /**
     * A constant pair, asserted anyway.
     *
     * Writing `status: 'SEARCHING'` straight into the insert would be the
     * first transition in the system that did not go through the gate, and
     * the second one is always easier to justify than the first.
     */
    assertOrderTransition('DRAFT', 'SEARCHING', { kind: 'system' });

    const outcome = await this.orders.createSearching({
      customerId: customer.id,
      addressId: input.addressId,
      serviceId: input.serviceId,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
    });

    if (outcome.kind === 'existing' && !describesSameRequest(outcome.order, input)) {
      throw new OrderIdempotencyKeyReusedError();
    }

    return toOrderResponse(outcome.order);
  }
}

/** Whether the stored order is the one this request is asking for again. */
function describesSameRequest(order: OrderRow, input: CreateOrderRequest): boolean {
  return (
    order.serviceId === input.serviceId &&
    order.addressId === input.addressId &&
    order.description === input.description
  );
}

function toOrderResponse(row: OrderRow): Order {
  return {
    id: row.id,
    status: row.status,
    serviceId: row.serviceId,
    addressId: row.addressId,
    description: row.description,
    priceMinor: row.priceMinor,
    masterId: row.masterId,
    redispatchCount: row.redispatchCount,
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
