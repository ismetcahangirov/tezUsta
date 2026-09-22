import { Logger } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';

import { ConnectionRegistry } from './connection.registry';
import type { AuthenticatedSocket } from './realtime.types';
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
 * **What this gateway does not do is as deliberate as what it does.** It has
 * no `@SubscribeMessage` handler, joins no room and publishes no event: rooms
 * and their authorization are #167, order events are #168, and position
 * fan-out is #169. Landing the transport on its own is what lets "the socket
 * exists and only authenticated callers hold one" be reviewed as the security
 * change it is, rather than buried in a feature.
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
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
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
  ) {}

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

  handleConnection(client: AuthenticatedSocket): void {
    this.connections.admit(client);
    this.scheduleExpiry(client);
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    this.connections.release(client);

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
