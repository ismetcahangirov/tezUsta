import { Injectable } from '@nestjs/common';
import type { CursorPage, Order } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { OrderRow } from '../../infra/database/schema/orders';
import { AddressesService } from '../addresses/addresses.service';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { ServicesService } from '../services/services.service';
import { decodeOrderCursor, encodeOrderCursor } from './order-cursor';
import { OrderDispatchRegistry } from './order-dispatch.registry';
import { InvalidOrderTransitionError, assertOrderTransition } from './order-lifecycle';
import { OrdersRepository } from './orders.repository';
import type { CreateOrderRequest, ListOrdersQuery, TransitionOrderRequest } from './orders.schema';

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
    private readonly masters: MastersService,
    private readonly dispatch: OrderDispatchRegistry,
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

    /**
     * **In the transaction's aftermath, not inside it** (issue #103).
     *
     * A job enqueued inside the transaction would be visible to a worker
     * before the order it names was committed, and the tick would find
     * nothing. Announced after it commits, the worst case is the reverse — a
     * committed order whose search is scheduled a moment later — which is a
     * delay rather than a lost order.
     *
     * Announced on the retry path too, and not only on `created`. A retry
     * means the first attempt's response was lost, and the attempt that
     * scheduled the search may have been lost with it; the engine's job ids
     * are derived from the order and its start time, so a second announcement
     * collapses into the schedule that already exists rather than starting a
     * second search.
     */
    await this.dispatch.started(outcome.order.id);

    return toOrderResponse(outcome.order);
  }

  /**
   * One of the caller's own orders.
   *
   * A stranger's order id answers **404, not 403**. A 403 would confirm the
   * order exists, which turns this route into a way to ask whether a given id
   * is somebody's order (`apps/api/src/common/errors/not-found.error.ts`).
   */
  async getById(actor: Actor, id: string): Promise<Order> {
    const customer = await this.customers.getOwn(actor);
    const row = await this.orders.findByIdForCustomer(id, customer.id);

    if (row === undefined) {
      throw new NotFoundError();
    }

    return toOrderResponse(row);
  }

  /** The caller's own orders, newest first, one page at a time. */
  async list(actor: Actor, query: ListOrdersQuery): Promise<CursorPage<Order>> {
    const customer = await this.customers.getOwn(actor);

    const { rows, hasMore } = await this.orders.listForCustomer({
      customerId: customer.id,
      limit: query.limit,
      after: decodeOrderCursor(query.cursor),
      status: query.status,
    });

    const last = rows.at(-1);
    return {
      items: rows.map(toOrderResponse),
      // A cursor only when there is something after it. Handing one back on
      // the final page would make a client fetch an empty page to find out.
      nextCursor:
        hasMore && last !== undefined
          ? encodeOrderCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * The assigned master moves their own job one status forward (issue #134).
   *
   * **Three checks, in this order, and the order is the point.** First the
   * caller is resolved to a master profile; then the order is found *and* it
   * is theirs, or the answer is 404; only then is the edge asked about. Asking
   * `assertOrderTransition` first would let a stranger distinguish
   * `ORDER_INVALID_TRANSITION` from 404 and so learn the status of an order
   * that is none of their business — an authorization check that leaks the
   * thing it is protecting.
   *
   * **A master the order was not assigned to gets 404, not 403.** A 403 would
   * confirm the order exists, which turns this route into a way to ask whether
   * a given id is somebody's job (`common/errors/not-found.error.ts`). Note
   * that this means `assertOrderTransition` is only ever reached here with
   * `isAssignedMaster: true` — the `assignedMaster` edges are the only ones
   * this route can walk, which is exactly what the schema's target list says.
   */
  async transition(actor: Actor, orderId: string, input: TransitionOrderRequest): Promise<Order> {
    const master = await this.masters.getOwn(actor);
    const order = await this.orders.findById(orderId);

    if (order === undefined || order.masterId !== master.id) {
      throw new NotFoundError();
    }

    assertOrderTransition(order.status, input.to, { kind: 'master', isAssignedMaster: true });

    const outcome = await this.orders.advance({
      orderId,
      from: order.status,
      to: input.to,
      actor: { kind: 'master', userId: actor.userId, reason: input.reason },
    });

    if (outcome === undefined) {
      throw new NotFoundError();
    }

    if (outcome.kind === 'stale') {
      /**
       * Somebody moved it between the check above and the write — the client
       * retrying, or two taps arriving together.
       *
       * Reported with the status the order **actually** has rather than the
       * one this request read, so a client that re-reads and a client that
       * trusts the error envelope end up believing the same thing. It is the
       * same 409 and the same code an illegal edge produces, and deliberately
       * so: from the caller's side "you cannot go there from where this order
       * is" is one fact, and splitting it into two codes would give the app
       * two screens for one situation.
       */
      throw new InvalidOrderTransitionError(outcome.order.status, input.to);
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
