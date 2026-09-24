import {
  type BaseQueryFn,
  type FetchArgs,
  fetchBaseQuery,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';

import { signedOut } from '../session/session-slice';

/** The CSRF header the API requires on every cookie-authenticated admin request (ADR-0043 § 4). */
export const ADMIN_CSRF_HEADER = 'X-TezUsta-Admin';

/**
 * Routes that establish or end a session. A 401 from one of them is the
 * answer itself — wrong credentials, a dead refresh cookie — never a reason
 * to try refreshing.
 */
const AUTH_PATH = /^\/admin\/auth\//;

const REFRESH_PATH = '/admin/auth/refresh';

const rawBaseQuery = fetchBaseQuery({
  // The session is two httpOnly cookies; the page never sees a token.
  credentials: 'same-origin',
  prepareHeaders: (headers) => {
    headers.set(ADMIN_CSRF_HEADER, '1');
    return headers;
  },
});

type AdminBaseQuery = BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError>;

/**
 * Every request goes to `/api` on the page's own origin — the panel never
 * talks to another one (ADR-0043 § 4), and nothing here can be configured to
 * make it. The origin is spelled out only because `Request` needs an absolute
 * URL outside a browser; in one it resolves to the same place.
 */
const sameOriginBaseQuery: AdminBaseQuery = (args, api, extraOptions) => {
  const request: FetchArgs = typeof args === 'string' ? { url: args } : args;
  return rawBaseQuery(
    { ...request, url: `${window.location.origin}/api${request.url}` },
    api,
    extraOptions,
  );
};

function pathOf(args: string | FetchArgs): string {
  return typeof args === 'string' ? args : args.url;
}

/**
 * `refused`: the server said the session is over. `failed`: the refresh did
 * not get an answer (network, 5xx), which is no evidence either way — the
 * original error goes back to the caller and the tab stays signed in.
 */
type RefreshOutcome = 'refreshed' | 'refused' | 'failed';

/**
 * One refresh at a time for the whole tab. Five queries that all meet an
 * expired access cookie must not send five refreshes: the refresh cookie
 * rotates on every use, and presenting a rotated one again is treated as
 * theft and revokes the session (ADR-0043 § 4). The first 401 starts the
 * refresh; every other one waits on the same promise.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

function refreshOnce(...[, api, extraOptions]: Parameters<AdminBaseQuery>) {
  refreshInFlight ??= (async (): Promise<RefreshOutcome> => {
    try {
      const { error } = await sameOriginBaseQuery(
        { url: REFRESH_PATH, method: 'POST' },
        // Its own signal: the refresh is shared, so it must not be cancelled
        // because the one request that happened to start it was.
        { ...api, signal: new AbortController().signal },
        extraOptions,
      );
      if (error === undefined) return 'refreshed';
      return error.status === 401 || error.status === 403 ? 'refused' : 'failed';
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * The panel's base query: same origin, CSRF header, and on a 401 from any
 * non-auth route one shared refresh followed by one retry. A refused refresh
 * marks the tab signed out; the authenticated shell reacts by showing the
 * sign-in page.
 */
export const adminBaseQuery: AdminBaseQuery = async (args, api, extraOptions) => {
  const result = await sameOriginBaseQuery(args, api, extraOptions);
  if (result.error?.status !== 401 || AUTH_PATH.test(pathOf(args))) {
    return result;
  }
  const outcome = await refreshOnce(args, api, extraOptions);
  if (outcome !== 'refreshed') {
    if (outcome === 'refused') api.dispatch(signedOut());
    return result;
  }
  const retried = await sameOriginBaseQuery(args, api, extraOptions);
  if (retried.error?.status === 401) {
    api.dispatch(signedOut());
  }
  return retried;
};
