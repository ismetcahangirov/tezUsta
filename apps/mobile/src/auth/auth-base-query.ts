import { createRetryingBaseQuery, type AppBaseQuery } from '../api/base-query';
import { signedIn, signedOut } from '../store/session-slice';

import { refreshCoordinator, type RefreshCoordinator } from './refresh';
import { tokenStore, type TokenStore } from './token-store';

const UNAUTHORIZED_STATUS = 401;

export interface AuthBaseQueryOptions {
  readonly baseUrl?: string;
  readonly tokens?: TokenStore;
  readonly coordinator?: RefreshCoordinator;
  /** Overridden in tests to drive a stub transport. */
  readonly fetchFn?: typeof fetch;
  /** Overridden in tests so a retry does not wait for real backoff. */
  readonly backoff?: (attempt: number, maxRetries: number) => Promise<void>;
}

function isUnauthorized(status: unknown): boolean {
  return status === UNAUTHORIZED_STATUS;
}

/**
 * The base query every request goes through: it attaches the access token, and
 * it makes a 401 invisible to the caller by refreshing and replaying.
 *
 * Transparency is the point. A screen must never have to know that its query
 * happened to be the one that crossed the fifteen-minute boundary; if it did,
 * every screen in the product would need the same three lines of recovery and
 * one of them would be missing them.
 *
 * `Stack.Protected` from expo-router 57 was considered for the route side of
 * this and rejected there (see `route-guard.ts`); it has no bearing here,
 * because a token expiring mid-session is a transport event and not a
 * navigation one.
 */
export function createAuthBaseQuery({
  baseUrl,
  tokens = tokenStore,
  coordinator = refreshCoordinator,
  fetchFn,
  backoff,
}: AuthBaseQueryOptions = {}): AppBaseQuery {
  const baseQuery = createRetryingBaseQuery({
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    ...(backoff ? { backoff } : {}),
    prepareHeaders: (headers) => {
      const accessToken = tokens.getAccessToken();
      if (accessToken !== null) {
        headers.set('Authorization', `Bearer ${accessToken}`);
      }
      return headers;
    },
  });

  return async (args, baseQueryApi, extraOptions) => {
    const tokenUsed = tokens.getAccessToken();
    const result = await baseQuery(args, baseQueryApi, extraOptions);

    if (!result.error || !isUnauthorized(result.error.status)) {
      return result;
    }

    if (tokenUsed === null) {
      // Nothing was sent to be stale. This is an unauthenticated call the
      // server refused — OTP request or verify, both of which are `@Public()`
      // and answer 401 for their own reasons. Refreshing here would trade a
      // perfectly good refresh token for nothing.
      return result;
    }

    if (tokens.getAccessToken() !== tokenUsed) {
      // Somebody else refreshed while this request was on the wire. Replaying
      // straight away is not an optimisation: starting a second refresh would
      // rotate a token that was just rotated, for a request that has not yet
      // been tried with the new one.
      return baseQuery(args, baseQueryApi, extraOptions);
    }

    const outcome = await coordinator.refresh();

    if (outcome.status === 'unavailable') {
      // Offline, or the API is down. The caller sees its original 401 and the
      // session survives to be refreshed when the network comes back.
      return result;
    }

    if (outcome.status === 'rejected') {
      // The coordinator has already cleared the keychain; this is the half the
      // UI reacts to. `dispatch` comes from the base query's own api object
      // rather than an imported store, so that the transport never imports the
      // store that owns it (`no-circular`, CLAUDE.md §14).
      baseQueryApi.dispatch(signedOut());
      return result;
    }

    if (outcome.identity !== null) {
      // Roles can change between sessions — a customer approved as a master
      // mid-session gets the new grant the next time a token is minted.
      baseQueryApi.dispatch(signedIn(outcome.identity));
    }

    const replayed = await baseQuery(args, baseQueryApi, extraOptions);

    if (replayed.error && isUnauthorized(replayed.error.status)) {
      // A freshly minted access token was refused. That is not an expiry, so
      // retrying cannot help: the account is suspended, or the session was
      // revoked between the refresh and the replay. End it here rather than
      // looping.
      await tokens.clear();
      baseQueryApi.dispatch(signedOut());
    }

    return replayed;
  };
}
