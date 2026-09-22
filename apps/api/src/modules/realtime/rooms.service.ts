import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

import type { AuthenticatedSocket } from './realtime.types';
import { RoomAuthorizer } from './room-authorizer';
import { orderRoom, roomFailure, ROOM_ERROR_CODES } from './room.types';
import type { RoomAck, RoomRequest } from './room.types';

/**
 * Joining, leaving, and being removed when the membership stops being true
 * (issue #167).
 *
 * The gateway owns the transport and this owns the decision, so "who may hear
 * what" can be read in one file rather than inferred from handler bodies.
 */
@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(private readonly authorizer: RoomAuthorizer) {}

  async join(client: AuthenticatedSocket, request: RoomRequest): Promise<RoomAck> {
    const room = await this.authorizer.resolve(client.data.actor, request);

    if (room === undefined) {
      // The reason is not on the wire, so it is recorded here — the same split
      // `socket.authenticator.ts` makes between what a client is told and what
      // an operator can find out. `request.kind` is our own word; no order id
      // reaches the log, because a refused caller's claim about which order
      // they wanted is not a fact worth writing down.
      this.logger.warn(`socket ${client.id} refused a ${request.kind} room`);
      return roomFailure(ROOM_ERROR_CODES.ROOM_FORBIDDEN);
    }

    await client.join(room);
    return { ok: true, room };
  }

  /**
   * Leaving needs no authorization — you may always stop listening — but it
   * still goes through {@link RoomAuthorizer} to build the name, so a client
   * cannot leave a room it was never entitled to name. `socket.leave` on a
   * room you are not in is a no-op, so an unauthorized request is answered
   * without revealing that difference either.
   */
  async leave(client: AuthenticatedSocket, request: RoomRequest): Promise<RoomAck> {
    const room = await this.authorizer.resolve(client.data.actor, request);

    if (room === undefined) {
      return roomFailure(ROOM_ERROR_CODES.ROOM_FORBIDDEN);
    }

    await client.leave(room);
    return { ok: true, room };
  }

  /**
   * Removes everyone in an order's room who is no longer a party to it.
   *
   * **This is what makes membership a live fact rather than a decision taken
   * once.** A master who re-dispatches an order is not merely refused a future
   * re-join: `orders.master_id` is cleared, this runs, and they stop hearing
   * that order without reconnecting. The same applies to a customer
   * cancellation and to an admin override, because every committed transition
   * reaches here through one registry (`order-rooms.registry.ts`).
   *
   * **Each socket is re-authorized from the database rather than compared
   * against the event.** The event carries the committed row's ids and
   * comparing them would be cheaper, but it would also be a second
   * implementation of "is this person on this order" living next to
   * {@link RoomAuthorizer.isOrderParty} — and the two drifting apart is how a
   * removed master keeps listening. The cost is a couple of reads on a
   * transition, which happens a handful of times per order.
   *
   * `fetchSockets()` is cluster-wide through the Redis adapter, so a socket
   * held by another instance is evicted too — `.leave()` on a `RemoteSocket`
   * is published to the instance that owns it. That is a round trip, which is
   * why this runs on transitions and not on publishes.
   */
  async revalidate(server: Server, orderId: string): Promise<void> {
    const room = orderRoom(orderId);
    const members = await server.in(room).fetchSockets();

    for (const member of members) {
      const actor = (member.data as AuthenticatedSocket['data']).actor;

      if (await this.authorizer.isOrderParty(actor, orderId)) {
        continue;
      }

      member.leave(room);
      this.logger.debug(`socket ${member.id} left an order room it is no longer a party to`);
    }
  }
}
