import { API_BASE_URL } from '../api/base-query';
import type { SessionIdentity } from '../store/session-slice';

import { readAccessTokenIdentity } from './access-token';
import type { TokenPairResponse } from './auth.types';
import { tokenStore, type TokenStore } from './token-store';

/** `POST /auth/refresh` — public, and the only endpoint called without a bearer token. */
const REFRESH_PATH = '/auth/refresh';

const SERVER_ERROR_STATUS = 500;

export type RefreshOutcome =
  /** A new pair is stored. `identity` is null only if the new token was unreadable. */
  | { readonly status: 'refreshed'; readonly identity: SessionIdentity | null }
  /**
   * The server refused, or there was nothing to present. The session is over
   * and the stored token has been cleared.
   */
  | { readonly status: 'rejected' }
  /**
   * The request never got an answer — offline, or the API is down. The refresh
   * token is **kept**: throwing away a 30-day credential because a train went
   * into a tunnel would make the user re-authenticate by SMS for a fault that
   * was never theirs.
   */
  | { readonly status: 'unavailable' };

export interface RefreshCoordinator {
  refresh(): Promise<RefreshOutcome>;
}

export interface RefreshCoordinatorOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly tokens?: TokenStore;
}

/**
 * Trades the stored refresh token for a new pair, **once at a time**.
 *
 * This is the single most consequential thing in the mobile auth layer, and
 * the reason is not performance.
 *
 * Every refresh rotates: the server issues a new refresh token and marks the
 * presented one spent, and presenting a spent token again is read as a stolen
 * credential being replayed — which revokes the entire session family
 * (docs/architecture/authentication.md § Refresh rotation with reuse
 * detection; issue #26). A screen that fires five requests on mount, all of
 * which 401 against the same expired access token, would therefore send the
 * *same* refresh token five times: one rotation succeeds and four land on a
 * row already marked used. The server correctly concludes it is being
 * attacked, and signs the user out of every device they own. A self-inflicted
 * logout, reproducible only under the concurrency that a slow network makes
 * more likely, not less.
 *
 * So concurrent callers share one promise. The second through fifth caller
 * makes no request at all; they await the first one's result and then replay
 * with the token it minted.
 *
 * `inFlight` is cleared when that promise settles, which leaves one honest
 * remaining case: a request that 401s *after* a refresh has already finished
 * starts a second refresh. That is not reuse — it presents the newly rotated
 * token, not the spent one — and `auth-base-query.ts` avoids even that round
 * trip by noticing that the access token changed under it.
 */
export function createRefreshCoordinator({
  baseUrl = API_BASE_URL,
  fetchFn,
  tokens = tokenStore,
}: RefreshCoordinatorOptions = {}): RefreshCoordinator {
  let inFlight: Promise<RefreshOutcome> | null = null;

  async function run(): Promise<RefreshOutcome> {
    const refreshToken = await tokens.getRefreshToken();
    if (refreshToken === null) {
      return { status: 'rejected' };
    }

    // Resolved per call, not captured as a default parameter when the
    // coordinator is built: this module is constructed at import time, and a
    // `fetch` bound then would ignore any later replacement of the global —
    // which is exactly how a test would drive a stub transport.
    const send = fetchFn ?? fetch;

    let response: Response;
    try {
      response = await send(`${baseUrl}${REFRESH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // No `Authorization` header, deliberately: `/auth/refresh` is a public
        // route, and the access token this is being called to replace is
        // expired anyway.
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return { status: 'unavailable' };
    }

    if (!response.ok) {
      if (response.status >= SERVER_ERROR_STATUS) {
        return { status: 'unavailable' };
      }

      // 401 or 403: the token is spent, revoked, or the family was killed by
      // reuse detection. Either way it will never work again, and keeping it
      // would mean retrying a dead credential on every subsequent 401.
      await tokens.clear();
      return { status: 'rejected' };
    }

    try {
      const pair = (await response.json()) as TokenPairResponse;
      await tokens.save(pair);
      return { status: 'refreshed', identity: readAccessTokenIdentity(pair.accessToken) };
    } catch {
      // A body that will not parse, or a keychain that will not write. Neither
      // is the server saying no, so the session is not destroyed over it.
      return { status: 'unavailable' };
    }
  }

  return {
    refresh() {
      // `??=` assigns before `run()`'s promise can settle, so the `finally`
      // below always runs after the assignment and can never null out a
      // promise that later callers are still joining.
      inFlight ??= run().finally(() => {
        inFlight = null;
      });

      return inFlight;
    },
  };
}

/** The app's coordinator. One per process, because there is one keychain. */
export const refreshCoordinator = createRefreshCoordinator();
