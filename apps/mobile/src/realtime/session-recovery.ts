import { readAccessTokenExpiry } from '../auth/access-token';
import type { RefreshCoordinator } from '../auth/refresh';
import type { TokenStore } from '../auth/token-store';
import type { SessionIdentity } from '../store/session-slice';

import type { Recovery, SocketEnding } from './realtime-connection';

/**
 * How close to its `exp` a token counts as expired, by the phone's clock.
 *
 * The API closes a socket at `exp` by **its** clock (`realtime.gateway.ts`,
 * `scheduleExpiry`), and the two clocks are not the same. A minute covers the
 * drift of a phone that sets its time from the network. A phone whose clock
 * runs further behind than that reads an expiry close as an eviction and waits
 * for the next foreground, which is how every close behaved before #468.
 */
export const EXPIRY_MARGIN_MS = 60_000;

export interface SessionRecoveryOptions {
  readonly tokens: Pick<TokenStore, 'getAccessToken'>;
  readonly coordinator: RefreshCoordinator;
  /** A refresh minted a new pair; roles may have changed with it. */
  readonly onRefreshed: (identity: SessionIdentity) => void;
  /** The refresh token was refused, so the session is over. */
  readonly onSessionEnded: () => void;
  readonly now?: () => number;
}

/**
 * Decides what the realtime connection does after socket.io gives up on a
 * socket (issue #468).
 *
 * **Expired: renew, then dial.** The access token is the socket's credential,
 * and the HTTP layer only refreshes after a 401, so a socket redialled with the
 * stored token would present the same dead one. The refresh goes through the
 * shared coordinator, which is single-flight: an HTTP 401 racing this must not
 * present the same refresh token twice, because reuse detection would revoke
 * the whole session family (`refresh.ts`).
 *
 * **Closed while the token is still good: stop.** The only other reason the
 * API closes a live socket is the per-account connection cap, which closes the
 * oldest. A client that always came back would close another of the same
 * account's sockets, which would come back too, in a loop. Staying closed
 * until the next foreground is what every server-side close did before #468.
 *
 * **Refused while the token is still good: dial again, without renewing.** The
 * handshake refuses a suspended account and a revoked session with the same
 * answer as an expired token, and also any failure to resolve the account. A
 * refresh would not fix the first two, and would rotate the token on every
 * retry. The HTTP layer ends a dead session on the next request.
 */
export function createSessionRecovery({
  tokens,
  coordinator,
  onRefreshed,
  onSessionEnded,
  now = Date.now,
}: SessionRecoveryOptions): (ending: SocketEnding) => Promise<Recovery> {
  return async (ending) => {
    const token = tokens.getAccessToken();
    const expiresAt = token === null ? null : readAccessTokenExpiry(token);
    // No token, or one that does not say when it expires, cannot be presented
    // as it is; renewing is the only way forward for either.
    const expiring = expiresAt === null || expiresAt - now() <= EXPIRY_MARGIN_MS;

    if (!expiring) {
      return ending === 'closed-by-server' ? 'stop' : 'retry';
    }

    const outcome = await coordinator.refresh();

    if (outcome.status === 'rejected') {
      onSessionEnded();
      return 'stop';
    }

    if (outcome.status === 'refreshed' && outcome.identity !== null) {
      onRefreshed(outcome.identity);
    }

    // `unavailable` too: offline, or the API is down. The backoff paces the
    // next attempt, and the refresh token is kept for it.
    return 'retry';
  };
}
