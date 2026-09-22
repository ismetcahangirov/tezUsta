import { Injectable } from '@nestjs/common';

import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { isTerminalOrderStatus } from '../orders/order-lifecycle';
import { OrdersRepository } from '../orders/orders.repository';
import { masterRoom, orderRoom } from './room.types';
import type { RoomRequest } from './room.types';

/**
 * Whether this actor may be in this room, decided **now** (issue #167).
 *
 * **Every answer is a database read, every time, and nothing is cached.** A
 * membership computed once at connect and kept for the life of the socket is
 * the same bug as trusting a frontend role check: an order is a moving target,
 * because a re-dispatch clears `orders.master_id` (#136), a customer cancels
 * (#135) and an admin overrides (#137). `socket.data.actor` is the one thing
 * carried over from the handshake, and `realtime.types.ts` already records why
 * it is a snapshot bounded by the token's `exp` rather than an authority.
 *
 * **An admin gets no blanket join.** `modules/admin` can drive any transition
 * the table permits, which is a different power from listening to a customer's
 * home address in real time. If an admin ever needs to observe a live order,
 * that is a separate path with its own reasoning and its own audit row — this
 * file does not quietly provide one by falling through to a role check.
 */
@Injectable()
export class RoomAuthorizer {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
  ) {}

  /**
   * The room name this actor may join for this request, or `undefined`.
   *
   * **One `undefined` for every refusal, and that is the security property.**
   * A missing order, a finished order, somebody else's order and somebody
   * else's master profile are indistinguishable to the caller, so the socket
   * cannot be used to ask whether an order id exists. `room.types.ts` says the
   * same thing about the code the client receives.
   */
  async resolve(actor: Actor, request: RoomRequest): Promise<string | undefined> {
    if (request.kind === 'master') {
      const master = await this.masters.findOwn(actor);

      return master !== undefined && master.id === request.masterId
        ? masterRoom(master.id)
        : undefined;
    }

    return (await this.isOrderParty(actor, request.orderId))
      ? orderRoom(request.orderId)
      : undefined;
  }

  /**
   * Whether this actor is a party to this order as the row stands.
   *
   * Public because eviction asks the same question of a socket already in the
   * room — the point of {@link RoomsService.revalidate} is that losing the
   * right removes you, rather than merely refusing a future re-join, and a
   * second implementation of "is this person on this order" is how the two
   * halves drift apart.
   */
  async isOrderParty(actor: Actor, orderId: string): Promise<boolean> {
    const order = await this.orders.findById(orderId);

    if (order === undefined) {
      return false;
    }

    /**
     * **A terminal order is not a live room.** There is nothing further to
     * publish about it, and the customer reads what happened over HTTP —
     * ADR-0033 makes the same call for the conversation, which becomes a
     * transcript at a terminal status rather than staying a channel. Leaving
     * the room joinable would mean a room that never emits and never empties.
     */
    if (isTerminalOrderStatus(order.status)) {
      return false;
    }

    /**
     * **The master edge is checked first and wins the tie**, which is
     * `orders.service#resolveParty`'s rule and is here for the same reason:
     * one account may hold both roles (`docs/product/user-roles.md`), so both
     * questions can be answered yes by one person. The `masterId` guard is
     * what makes a plumber whose own fridge broke the *customer* on that
     * order.
     *
     * `findOwn` rather than `getOwn` on both, so an actor who legitimately
     * holds only one profile does not have the question answered by a 404
     * thrown from inside the lookup.
     */
    if (order.masterId !== null) {
      const master = await this.masters.findOwn(actor);

      if (master !== undefined && master.id === order.masterId) {
        return true;
      }
    }

    const customer = await this.customers.findOwn(actor);

    return customer !== undefined && customer.id === order.customerId;
  }
}
