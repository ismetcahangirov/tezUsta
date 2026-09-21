import { Inject, Injectable } from '@nestjs/common';
import type { CursorPage, Order, OrderStatus } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { OrderRow } from '../../infra/database/schema/orders';
import { AddressesService } from '../addresses/addresses.service';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { ServicesService } from '../services/services.service';
import { decodeOrderCursor, encodeOrderCursor } from './order-cursor';
import { OrderDispatchRegistry } from './order-dispatch.registry';
import { OrderNotificationsRegistry } from './order-notifications.registry';
import type { OrderTransitionActor } from './order-lifecycle';
import {
  InvalidOrderTransitionError,
  assertOrderTransition,
  isTerminalOrderStatus,
} from './order-lifecycle';
import type { AdvanceOrderOutcome, TransitionActorRecord } from './orders.repository';
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
    private readonly orderNotifications: OrderNotificationsRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
   * The one route an order's status changes through, for the two people the
   * order belongs to (issues #134, #135, #136).
   *
   * **Who the caller is to *this order* is resolved first, and from the order
   * row** — never from the target they asked for, and never from a role claim.
   * A route that picked the actor kind out of the request body would let a
   * customer be checked as a master by asking for a master's edge, and the
   * transition table would then be asked the wrong question in exactly the
   * cases that matter.
   *
   * **Three checks, in this order, and the order is the point.** The order is
   * found; the caller is resolved to the customer or the assigned master, or
   * the answer is 404; only then is the edge asked about. Asking
   * `assertOrderTransition` first would let a stranger distinguish
   * `ORDER_INVALID_TRANSITION` from 404 and so learn the status of an order
   * that is none of their business — an authorization check that leaks the
   * thing it is protecting.
   *
   * **A stranger gets 404, not 403.** A 403 would confirm the order exists,
   * which turns this route into a way to ask whether a given id is somebody's
   * job (`common/errors/not-found.error.ts`). The order's **own** customer
   * asking for a master's edge gets 403 instead, and that is not an
   * inconsistency: by then the caller has been established as a party to the
   * order, so its existence is not a secret being kept from them, and what is
   * being refused is the operation.
   */
  async transition(actor: Actor, orderId: string, input: TransitionOrderRequest): Promise<Order> {
    const order = await this.orders.findById(orderId);

    if (order === undefined) {
      throw new NotFoundError();
    }

    const party = await this.resolveParty(actor, order);

    assertOrderTransition(order.status, input.to, party.entitlement);

    return this.perform(order, input.to, {
      kind: party.kind,
      userId: actor.userId,
      reason: input.reason,
    });
  }

  /**
   * An admin drives any edge the table contains, on any order (issue #137).
   *
   * **The actor check is bypassed; the edge check is not, and there is no
   * parameter here that could skip it.** `backend-architecture.md` § Admin
   * override states the rule exactly — "an admin may not perform a transition
   * the table does not contain, and there is no code path that lets them" — so
   * this method differs from {@link transition} in one line: it resolves no
   * party, and hands `assertOrderTransition` an `admin` actor, which
   * `order-lifecycle.ts` answers by returning early from the *actor* check
   * alone. If an operational situation needs an edge that does not exist, the
   * answer is a new ADR, not a flag on this call.
   *
   * **Side effects follow the target, not the actor.** It goes through the
   * same {@link perform} the other two do, so an admin-driven `SEARCHING`
   * performs the whole re-dispatch transaction — master cleared, price
   * cleared, `redispatch_count` incremented, cap honoured — rather than a bare
   * status write, and an admin-driven terminal status closes the order's live
   * offers.
   *
   * Takes an admin **id**, not an `AdminActor`: `modules/admin` imports
   * `modules/orders` and the arrow may not point back (CLAUDE.md §14). What
   * an order needs of an admin is the id that goes on the trail row, and
   * `AdminOrdersService` is where the rest of an admin lives.
   */
  async override(adminUserId: string, orderId: string, input: OrderOverride): Promise<Order> {
    const order = await this.orders.findById(orderId);

    if (order === undefined) {
      throw new NotFoundError();
    }

    assertOrderTransition(order.status, input.to, { kind: 'admin' });

    return this.perform(order, input.to, {
      kind: 'admin',
      adminId: adminUserId,
      reason: input.reason,
    });
  }

  /**
   * Which party to this order the caller is — or 404, when they are neither.
   *
   * **The assigned master is asked about first, and only when the order has
   * one.** One account can hold both roles (`docs/product/user-roles.md`: a
   * plumber with a broken fridge is one account with two grants), so both
   * questions can be answered yes by the same person. The assigned master's
   * edges are the ones that move a job actually in progress, so they win the
   * tie; the customer's single edge is cancellation, which is available from
   * every status the master's edges leave from, so nothing is lost by losing
   * the tie.
   *
   * `findOwn` rather than `getOwn` on both, because this route serves callers
   * who legitimately have only one of the two profiles: a 404 thrown from
   * inside the question would answer a different question from the one asked.
   */
  private async resolveParty(actor: Actor, order: OrderRow): Promise<OrderParty> {
    if (order.masterId !== null) {
      const master = await this.masters.findOwn(actor);

      if (master !== undefined && master.id === order.masterId) {
        return { kind: 'master', entitlement: { kind: 'master', isAssignedMaster: true } };
      }
    }

    const customer = await this.customers.findOwn(actor);

    if (customer !== undefined && customer.id === order.customerId) {
      return { kind: 'customer', entitlement: { kind: 'customer', isOrderCustomer: true } };
    }

    throw new NotFoundError();
  }

  /**
   * Writes a transition the caller has already been found entitled to, with
   * whatever else that particular target owes.
   *
   * **Side effects follow the target, never the actor.** A re-dispatch clears
   * the master, the price and the accept timestamp, and a move into a terminal
   * status closes the order's live offers, whoever asked for it — which is
   * what lets the admin override reuse this method rather than grow a second
   * implementation of "move an order", and a second implementation is a second
   * place for the trail row to be forgotten.
   */
  private async perform(
    order: OrderRow,
    to: OrderStatus,
    actor: TransitionActorRecord,
  ): Promise<Order> {
    const outcome = await this.write(order, to, actor);

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
      throw new InvalidOrderTransitionError(outcome.order.status, to);
    }

    await this.announce(outcome.order, to);
    await this.raiseNotifications(outcome.order, actor);

    return toOrderResponse(outcome.order);
  }

  /**
   * The transaction the target calls for.
   *
   * Three transactions rather than one with flags, because they are genuinely
   * different writes and collapsing them would mean a boolean deciding whether
   * a `price_minor` gets cleared. Which one a target needs is asked of
   * `order-lifecycle.ts` rather than of a list kept here: "is this status
   * terminal" is a fact about the transition table, and a second list would be
   * a second answer to it.
   */
  private write(
    order: OrderRow,
    to: OrderStatus,
    actor: TransitionActorRecord,
  ): Promise<AdvanceOrderOutcome | undefined> {
    if (to === 'SEARCHING') {
      return this.orders.redispatch({
        orderId: order.id,
        from: order.status,
        actor,
        // Read through on every call, never copied into a field: the cap is
        // configuration (ADR-0015), and a literal here is exactly what that
        // makes impossible to change without a deploy of this file.
        maxRedispatches: this.config.dispatch.maxOrderRedispatches,
      });
    }

    if (isTerminalOrderStatus(to)) {
      return this.orders.finish({ orderId: order.id, from: order.status, to, actor });
    }

    return this.orders.advance({ orderId: order.id, from: order.status, to, actor });
  }

  /**
   * Tells the dispatch engine that this order's search has started or ended.
   *
   * **Announced from the committed row's status, not from the target asked
   * for.** A re-dispatch that hit `MAX_ORDER_REDISPATCHES` asked for
   * `SEARCHING` and landed on `NO_MASTER_FOUND`, and announcing a search that
   * the transaction deliberately ended in the same breath would schedule a
   * plan of waves against a terminal order. The row is what actually happened.
   *
   * **Always after the transaction commits, and never checked.** A job
   * enqueued inside the transaction would be visible to a worker before the
   * order it names was committed (issue #103), and every remaining tick guards
   * on the database anyway, so a queue error here costs a handful of reads and
   * writes nothing — `OrderDispatchRegistry` swallows its own failures for
   * exactly that reason. Turning a Redis hiccup into a 500 would tell a master
   * their job is still theirs when the database says it is not.
   */
  /**
   * Tells the parties to this order that it moved.
   *
   * **Every transition in the system passes through here**, whoever asked for
   * it — the assigned master advancing the job, the customer cancelling, a
   * re-dispatch, and an admin override, which reuses this same method rather
   * than growing a second implementation of "move an order". That is what
   * makes "nobody is notified of their own action" a property of one
   * subtraction instead of a condition repeated at four call sites: the actor
   * is handed over, and `OrderNotificationsService` removes them from the
   * recipients.
   *
   * **From the committed row, and after the transaction**, for both of the
   * reasons {@link announce} gives. The row is what actually happened — a
   * re-dispatch that hit the cap asked for `SEARCHING` and landed on
   * `NO_MASTER_FOUND`, and the customer must be told the one that is true. And
   * a job enqueued inside the transaction would be visible to a worker before
   * the order it names was committed, which is how a customer gets told their
   * order was accepted by a transaction that then rolled back.
   *
   * `actor.userId` is absent for an admin and for the system. Neither is ever
   * in the recipient set, so neither needs excluding — the admin driving an
   * override is told nothing because they are not a party, not because
   * somebody remembered to filter them out.
   */
  private async raiseNotifications(written: OrderRow, actor: TransitionActorRecord): Promise<void> {
    await this.orderNotifications.transitioned({
      orderId: written.id,
      customerId: written.customerId,
      masterId: written.masterId,
      to: written.status,
      actorUserId: actor.userId,
    });
  }

  private async announce(written: OrderRow, to: OrderStatus): Promise<void> {
    if (to !== 'SEARCHING' && !isTerminalOrderStatus(to)) {
      return;
    }

    if (written.status === 'SEARCHING') {
      await this.dispatch.started(written.id);
      return;
    }

    await this.dispatch.ended(written.id);
  }
}

/**
 * An admin's request to move one order, as `modules/orders` sees it.
 *
 * Declared here rather than imported from `admin-orders.schema.ts`, so that
 * the dependency keeps pointing one way: the admin module's inferred request
 * type is structurally this, and nothing in `modules/orders` has to know that
 * `modules/admin` exists (CLAUDE.md §14).
 */
export interface OrderOverride {
  readonly to: OrderStatus;
  /** Mandatory on every override, with no exception (ADR-0015). */
  readonly reason: string;
}

/**
 * The caller's standing on one particular order: what to record against the
 * trail row, and what to ask the transition table.
 *
 * Two fields rather than one because they answer different questions and the
 * table's vocabulary is deliberately narrower than the trail's — `system` and
 * `admin` are actor kinds with no place in an edge's requirement list, and
 * `assignedMaster` is a requirement with no place in an enum of who exists.
 */
interface OrderParty {
  readonly kind: 'customer' | 'master';
  readonly entitlement: OrderTransitionActor;
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
