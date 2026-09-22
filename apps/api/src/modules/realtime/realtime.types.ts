import type { Socket } from 'socket.io';

import type { Actor } from '../auth/auth.types';

/**
 * What the gateway stores on a socket once it has proved who is holding it.
 *
 * **This travels.** `socket.data` is serialised into the cluster adapter's
 * `FETCH_SOCKETS_RESPONSE` and published over Redis whenever any instance
 * calls `fetchSockets()` — so nothing here may be a credential, and nothing
 * here should be large. The access token that opened the socket is destroyed
 * during authentication for exactly this reason
 * (`socket.authenticator.ts`).
 *
 * It is also **not** a cache that saves a lookup: reading another instance's
 * `socket.data` is itself a cluster round trip.
 */
export interface RealtimeSocketData {
  /**
   * Resolved by `ActorService` **from the database**, never from the token's
   * `roles` claim — see `actor.service.ts`. Present on every socket that
   * completed the upgrade, because the middleware that sets it is what admits
   * the connection.
   *
   * **It is a snapshot, and it is bounded rather than refreshed.** A role
   * withdrawn or an account suspended after this moment is not reflected
   * here; {@link expiresAtMs} is what stops that snapshot outliving the
   * credential it came from. Any authorization decision taken later must
   * re-read current state through `ActorService` rather than trusting this —
   * the same rule that makes a token's `roles` claim a cache rather than an
   * authority.
   */
  readonly actor: Actor;
  /**
   * When this socket's authentication stops being current: the `exp` of the
   * access token that opened it, in milliseconds.
   *
   * The gateway closes the socket at this instant. Without it a socket
   * authenticated once would hold a frozen actor for as long as the phone
   * kept the connection open — hours on a home screen — and "a revoked
   * session must not survive inside a long-lived socket" would be true only
   * of clients that happened to reconnect.
   */
  readonly expiresAtMs: number;
}

/** A socket that has passed `SocketAuthenticator`. */
export type AuthenticatedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  RealtimeSocketData
>;
