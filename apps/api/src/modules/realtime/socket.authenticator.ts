import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';

import { ActorService } from '../auth/actor.service';
import { InvalidAccessTokenError, TokenService } from '../auth/token.service';
import type { AuthenticatedSocket } from './realtime.types';

/**
 * The one message every refusal carries.
 *
 * Deliberately a single string for every cause, exactly as the HTTP 401 is
 * (issue #27, `actor.service.ts`). A client that could tell `expired` from
 * `session_revoked` from `account_not_active` would hold an oracle over
 * accounts it may not own; an operator answering "why was I signed out?" needs
 * that distinction and gets it from the server log below.
 */
export const SOCKET_UNAUTHORIZED = 'unauthorized';

/** What a client is expected to send in the socket.io handshake. */
interface HandshakeAuth {
  readonly token?: unknown;
}

/**
 * Authentication for the WebSocket upgrade (issue #166).
 *
 * **It runs as socket.io middleware, not in `handleConnection`.** The
 * difference is not stylistic: middleware rejects before the connection is
 * established, so the client receives `connect_error` and never fires
 * `connect`. Authenticating in `handleConnection` would mean accepting the
 * socket and then closing it — an upgraded, briefly-live connection for a
 * caller who proved nothing, which is what
 * `realtime-architecture.md` § Connection lifecycle forbids.
 *
 * **It re-authenticates on every connection, which is what makes a reconnect
 * a new authentication.** socket.io runs this middleware for each new
 * connection attempt, including every reconnect, so a session revoked while a
 * client was offline cannot come back through a long-lived socket.
 *
 * It resolves the actor through the same `TokenService` + `ActorService` pair
 * the HTTP guard uses, rather than a copy: the guarantee that a withdrawn role
 * or a suspended account takes effect on the next request must not be one that
 * holds on HTTP and quietly does not on the socket.
 */
@Injectable()
export class SocketAuthenticator {
  private readonly logger = new Logger(SocketAuthenticator.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly actors: ActorService,
  ) {}

  /**
   * The middleware to hand to `server.use()`.
   *
   * Bound here rather than passed as a method reference so `this` survives
   * socket.io calling it.
   */
  middleware(): (socket: Socket, next: (error?: Error) => void) => void {
    return (socket, next) => {
      void this.authenticate(socket)
        .then(() => {
          next();
        })
        .catch((error: unknown) => {
          this.logRefusal(socket, error);
          next(new Error(SOCKET_UNAUTHORIZED));
        });
    };
  }

  private async authenticate(socket: Socket): Promise<void> {
    const claims = this.tokens.verifyAccessToken(this.readToken(socket));
    const actor = await this.actors.resolve(claims);

    // **The credential is destroyed the moment it has been spent.**
    //
    // socket.io keeps `handshake` for the socket's whole lifetime, and the
    // cluster adapter serialises the *entire* handshake into its
    // `FETCH_SOCKETS_RESPONSE` — stripping only `sessionStore`
    // (`socket.io-adapter/dist/cluster-adapter.js`). So a single cluster-wide
    // `fetchSockets()` would publish every connected user's live access token
    // onto a Redis channel that ADR-0032 itself records as unsigned and
    // unauthenticated. Verified by running exactly that against two instances
    // before this line existed: the token came back in the serialised
    // response.
    //
    // This is the same argument `readToken` makes below about the query
    // string. A handshake holds the token just as durably, and this API is
    // the one the repository's own multi-instance test already calls.
    socket.handshake.auth = {};

    const data = socket.data as AuthenticatedSocket['data'];
    Object.assign(data, { actor, expiresAtMs: claims.exp * 1000 });
  }

  /**
   * Reads the access token from the handshake's `auth` payload — and from
   * nowhere else.
   *
   * **Not the query string, and not by accident.** A query string is part of
   * the URL: it lands in proxy logs, in access logs, and in anything that
   * records where a request went, which would put a live credential in
   * exactly the places CLAUDE.md §11 says a token may never be written. The
   * handshake `auth` field is sent in the connection payload instead, and a
   * client that puts the token in the query simply fails to authenticate —
   * `realtime.gateway.e2e.test.ts` pins that.
   *
   * There is no `Authorization` header path either. A browser cannot set
   * headers on a WebSocket upgrade at all, so supporting it would be a second
   * way in that only some clients can use, and a second thing to get wrong.
   */
  private readToken(socket: Socket): string {
    const auth = socket.handshake.auth as HandshakeAuth | undefined;
    const token = auth?.token;

    if (typeof token !== 'string' || token.length === 0) {
      throw new InvalidAccessTokenError('missing_credentials');
    }

    return token;
  }

  /**
   * The **only** place the reason is recorded, and it goes to the server log —
   * never to the client, which gets {@link SOCKET_UNAUTHORIZED} for every
   * cause. `error.reason` is a fixed vocabulary of our own words: no part of
   * the token, the handshake or a phone number reaches this line.
   */
  private logRefusal(socket: Socket, error: unknown): void {
    const reason =
      error instanceof InvalidAccessTokenError ? error.reason : 'unexpected_authentication_error';

    this.logger.warn(`socket ${socket.id} rejected: ${reason}`);

    // An error that is not an authentication failure is a fault, not a
    // refusal, and the client still only learns that it was refused.
    if (!(error instanceof InvalidAccessTokenError)) {
      this.logger.error(
        `socket authentication failed unexpectedly: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
