import { Logger, OnModuleInit } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server } from 'socket.io';

import { OrderRoomsRegistry } from '../orders/order-rooms.registry';
import { ConnectionRegistry } from './connection.registry';
import { InboundBudget } from './inbound-budget';
import { roomRequestSchema } from './realtime.schema';
import type { AuthenticatedSocket } from './realtime.types';
import { RoomsService } from './rooms.service';
import { roomFailure, ROOM_ERROR_CODES, userRoom } from './room.types';
import type { RoomAck, RoomErrorCode, RoomRequest } from './room.types';
import { SocketAuthenticator } from './socket.authenticator';

/**
 * How long a refused client may keep its transport open.
 *
 * **This is the bound on unauthenticated connections, and the connection cap
 * is not.** A middleware refusal rejects the *namespace* connection, not the
 * *transport* one: socket.io sends `CONNECT_ERROR` and leaves the engine.io
 * connection open until `connectTimeout`, whose default is 45 seconds
 * (`socket.io/dist/index.js`). A cooperative client closes immediately; a
 * hostile one does not, and `ConnectionRegistry` cannot see it because it has
 * no account to be counted against. Verified by holding raw WebSockets open
 * past a rejecting middleware — five refused clients, five live transports.
 *
 * Three seconds is well past the round trip an honest client needs to read
 * `connect_error` and close, and it cuts the window a credential-less flood
 * can hold a file descriptor by fifteen times.
 */
const REFUSED_CONNECTION_TIMEOUT_MS = 3_000;

/**
 * The socket's front door (issue #166).
 *
 * **What this gateway does not do is still as deliberate as what it does.**
 * It still publishes nothing itself: order events reach the socket through
 * `OrderEventsPublisher` (#168) and position fan-out is #169. What it owns is
 * the connection — who holds one, what it may hear, and how long it lives.
 *
 * **No port argument.** `@WebSocketGateway()` with options only attaches to
 * the application's existing HTTP server, so the socket lives on the same
 * Fastify port as the REST API and deployment gains nothing new to expose.
 * Passing a number as the first argument would open a second listener.
 */
@WebSocketGateway({
  // socket.io otherwise serves its browser client bundle at
  // `/socket.io/socket.io.js`. Nothing consumes it here — the mobile app
  // bundles its own client — and an API that serves JavaScript is a surface
  // with no reason to exist.
  serveClient: false,
  connectTimeout: REFUSED_CONNECTION_TIMEOUT_MS,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /** Per socket id, so a disconnect can cancel the timer it scheduled. */
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Assigned by Nest after `afterInit`. Public because the fan-out issues
   * (#168, #169) publish through it, and because the multi-instance test
   * publishes from one application and asserts on the other.
   */
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly authenticator: SocketAuthenticator,
    private readonly connections: ConnectionRegistry,
    private readonly rooms: RoomsService,
    private readonly budget: InboundBudget,
    private readonly orderRooms: OrderRoomsRegistry,
  ) {}

  /**
   * Subscribes to committed order transitions, so a party who stops being one
   * is removed from the order's room rather than merely refused a re-join
   * (issue #167).
   *
   * `onModuleInit` rather than `afterInit`: the latter fires when socket.io
   * attaches, which only happens once the application listens, and a
   * transition committed before that would find nobody registered.
   * {@link server} is not touched here — it is read inside the callback, by
   * which time Nest has assigned it.
   */
  onModuleInit(): void {
    this.orderRooms.register(async (orderId) => {
      await this.rooms.revalidate(this.server, orderId);
    });
  }

  /**
   * Subscribe to an order's or a master's live events.
   *
   * **Validation, budget, then authorization — in that order.** The budget is
   * spent before the database is touched, because a flood that gets as far as
   * a query has already cost the thing the budget exists to protect.
   * Validation comes first only because it is free.
   *
   * Returning the ack rather than emitting an error event: a refusal belongs
   * to the request that caused it, and a client that sent two joins would not
   * know which of them a lone `room:error` referred to.
   */
  @SubscribeMessage('room:join')
  async handleJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: unknown,
  ): Promise<RoomAck> {
    const request = this.accept(client, payload);
    return typeof request === 'string' ? roomFailure(request) : this.rooms.join(client, request);
  }

  /** Stop listening. Same checks, because a leave is still an inbound frame. */
  @SubscribeMessage('room:leave')
  async handleLeave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: unknown,
  ): Promise<RoomAck> {
    const request = this.accept(client, payload);
    return typeof request === 'string' ? roomFailure(request) : this.rooms.leave(client, request);
  }

  /**
   * The two checks every inbound frame passes, or the code that stopped it.
   *
   * **Neither failure disconnects the socket.** A malformed frame is one
   * client bug or one probe on a connection that may be carrying a live order,
   * and closing it would turn a rejected message into a lost job — which is
   * what `realtime.schema.ts` means by "rejected without disconnecting the
   * world". A flood is bounded by the budget refusing to refill, and by
   * `ConnectionRegistry` bounding how many sockets the account holds at all.
   */
  private accept(client: AuthenticatedSocket, payload: unknown): RoomRequest | RoomErrorCode {
    const parsed = roomRequestSchema.safeParse(payload);

    if (!parsed.success) {
      return ROOM_ERROR_CODES.ROOM_INVALID;
    }

    if (!this.budget.consume(client)) {
      this.logger.warn(`socket ${client.id} exceeded its inbound message budget`);
      return ROOM_ERROR_CODES.RATE_LIMITED;
    }

    return parsed.data;
  }

  /**
   * Installs authentication here rather than in the adapter, so it applies
   * wherever this gateway is mounted.
   *
   * The Redis adapter is chosen by whichever `IoAdapter` the application
   * installed (`RealtimeIoAdapter` in `main.ts`); authentication is not
   * negotiable in the same way, and wiring it into the adapter would mean an
   * application that forgot `useWebSocketAdapter` served an open socket.
   */
  afterInit(server: Server): void {
    server.use(this.authenticator.middleware());
  }

  /**
   * Admits the connection, and puts it in the one room it does not have to ask
   * for.
   *
   * `user:{userId}` is joined here from `client.data.actor`, which the
   * authenticating middleware resolved from the database — so a socket is in
   * exactly one personal room and it is its own. Nothing publishes into it;
   * it is subtracted from an order broadcast so that the actor of a transition
   * is not told about their own action (`room.types.ts`, issue #168).
   *
   * `join` on a local socket resolves synchronously in socket.io's own
   * adapters, and the returned promise is not awaited because Nest ignores a
   * connection hook's return value anyway — a `void` signature that quietly
   * returned a promise would be a rejection nobody handles.
   */
  handleConnection(client: AuthenticatedSocket): void {
    this.connections.admit(client);
    void client.join(userRoom(client.data.actor.userId));
    this.scheduleExpiry(client);
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    this.connections.release(client);
    this.budget.release(client);

    const timer = this.expiryTimers.get(client.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.expiryTimers.delete(client.id);
    }

    this.logger.debug(`socket ${client.id} disconnected`);
  }

  /**
   * Closes the socket when the access token that opened it expires.
   *
   * **This is what makes "a revoked session must not survive inside a
   * long-lived socket" true of every client, not only the ones that happen to
   * reconnect.** The actor on a socket is resolved once and then frozen; a
   * phone left on a screen holds that snapshot for hours, so an admin
   * suspending a master mid-shift would not reach them. Bounding the socket
   * by the credential's own `exp` means the stale snapshot can outlive the
   * truth by at most the access token's 15 minutes — the same window
   * `authentication.md` already accepts for HTTP, and no longer.
   *
   * The client reconnects, which is a fresh authentication, and refetches
   * state over HTTP — both already required of it by
   * `realtime-architecture.md` § Connection lifecycle.
   *
   * It does **not** replace re-reading current state before an authorization
   * decision. #167 still has to do that for a room join.
   */
  private scheduleExpiry(client: AuthenticatedSocket): void {
    const remaining = client.data.expiresAtMs - Date.now();

    if (remaining <= 0) {
      // Already past `exp`. Only reachable if the clock moved or the token
      // expired between verification and this hook; either way it does not
      // get to stay.
      client.disconnect(true);
      return;
    }

    const timer = setTimeout(() => {
      this.expiryTimers.delete(client.id);
      this.logger.debug(`socket ${client.id} closed: its access token expired`);
      client.disconnect(true);
    }, remaining);

    // The process must be allowed to exit with these pending. Without it a
    // shutdown would wait up to a full token lifetime for a timer whose only
    // job is to close a socket the shutdown is closing anyway.
    timer.unref();
    this.expiryTimers.set(client.id, timer);
  }
}
