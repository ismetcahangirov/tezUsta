import type { AppBaseQuery } from '../api/base-query';

import { createAuthBaseQuery } from './auth-base-query';
import { createRefreshCoordinator } from './refresh';
import type { TokenStore } from './token-store';

const BASE_URL = 'http://api.test';

function accessTokenFor(roles: string[]): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', roles })).toString('base64url');
  return `header.${payload}.signature`;
}

const FIRST_ACCESS = accessTokenFor(['customer']);
const SECOND_ACCESS = accessTokenFor(['customer', 'master']);

/**
 * A token store backed by two variables. The keychain is exercised by
 * `token-store.test.ts`; what matters here is which token a request carried
 * and when it changed.
 */
function fakeTokenStore(access: string | null, refresh: string | null): TokenStore {
  let accessToken = access;
  let refreshToken = refresh;

  return {
    getAccessToken: () => accessToken,
    getRefreshToken: () => Promise.resolve(refreshToken),
    save(pair) {
      accessToken = pair.accessToken;
      refreshToken = pair.refreshToken;
      return Promise.resolve();
    },
    clear() {
      accessToken = null;
      refreshToken = null;
      return Promise.resolve();
    },
  };
}

function pairBody(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    accessToken,
    accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
    refreshToken,
    refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
  });
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

interface Transport {
  /** Every request the app made, in order, as `METHOD path` with its bearer. */
  readonly log: { path: string; authorization: string | null }[];
  readonly fetchFn: typeof fetch;
}

/**
 * One stub transport for both the API and `/auth/refresh`, so a single counter
 * sees everything: a test that counted refreshes through a separate fake could
 * not notice one arriving by another route.
 *
 * `/orders` answers 401 to anything but the current access token, which is
 * what an expired token looks like from the client's side.
 */
function transport({
  refreshStatus = 200,
  currentAccess = SECOND_ACCESS,
  delayMs = 0,
  apiStatus,
  mintedAccess,
}: {
  refreshStatus?: number;
  /** The only token `/orders` will accept. */
  currentAccess?: string;
  delayMs?: number;
  /** Forces every non-auth response to this status, whatever the token says. */
  apiStatus?: number;
  /**
   * What `/auth/refresh` hands back. Defaults to the token the API accepts;
   * set it to something else to model a refresh that succeeds and still
   * leaves the caller unauthorised.
   */
  mintedAccess?: string;
} = {}): Transport {
  const log: { path: string; authorization: string | null }[] = [];

  const fetchFn = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    const authorization =
      typeof input === 'string'
        ? ((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null)
        : input.headers.get('Authorization');
    const path = url.replace(BASE_URL, '');

    log.push({ path, authorization });

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (path === '/auth/refresh') {
      return refreshStatus === 200
        ? json(pairBody(mintedAccess ?? currentAccess, 'row-2.secret'))
        : json(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), refreshStatus);
    }

    if (apiStatus !== undefined) {
      return json(JSON.stringify({ error: { code: 'VALIDATION_FAILED' } }), apiStatus);
    }

    return authorization === `Bearer ${currentAccess}`
      ? json(JSON.stringify({ ok: true }))
      : json(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), 401);
  }) as unknown as typeof fetch;

  return { log, fetchFn };
}

/**
 * The object RTK Query hands a base query at call time. Supplying it here is
 * what lets the real `fetchBaseQuery` run without a store behind it.
 */
function baseQueryApi(dispatch: jest.Mock): Parameters<AppBaseQuery>[1] {
  return {
    signal: new AbortController().signal,
    abort: () => undefined,
    dispatch,
    getState: () => ({}),
    extra: undefined,
    endpoint: 'orders',
    type: 'query' as const,
    forced: false,
  } as Parameters<AppBaseQuery>[1];
}

function build(
  tokens: TokenStore,
  fetchFn: typeof fetch,
): { baseQuery: AppBaseQuery; dispatch: jest.Mock } {
  const dispatch = jest.fn();
  const coordinator = createRefreshCoordinator({ baseUrl: BASE_URL, fetchFn, tokens });
  const baseQuery = createAuthBaseQuery({
    baseUrl: BASE_URL,
    tokens,
    coordinator,
    fetchFn,
    backoff: () => Promise.resolve(),
  });

  return { baseQuery, dispatch };
}

function dispatchedTypes(dispatch: jest.Mock): string[] {
  return dispatch.mock.calls.map(([action]) => (action as { type: string }).type);
}

describe('the authenticated base query', () => {
  it('sends the access token as a bearer token', async () => {
    const { log, fetchFn } = transport({ currentAccess: FIRST_ACCESS });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/orders', baseQueryApi(dispatch), {});

    expect(result.data).toEqual({ ok: true });
    expect(log).toEqual([{ path: '/orders', authorization: `Bearer ${FIRST_ACCESS}` }]);
  });

  it('sends no bearer token when there is no session', async () => {
    const { log, fetchFn } = transport();
    const tokens = fakeTokenStore(null, null);
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    await baseQuery('/auth/otp/request', baseQueryApi(dispatch), {});

    expect(log[0]?.authorization).toBeNull();
  });

  it('refreshes and replays a 401, so the caller never sees it', async () => {
    const { log, fetchFn } = transport();
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/orders', baseQueryApi(dispatch), {});

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ ok: true });
    expect(log.map((entry) => entry.path)).toEqual(['/orders', '/auth/refresh', '/orders']);
    // The replay carries the new token, not the one that was rejected.
    expect(log[2]?.authorization).toBe(`Bearer ${SECOND_ACCESS}`);
  });

  it('announces the roles the refreshed token carries', async () => {
    const { fetchFn } = transport();
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    await baseQuery('/orders', baseQueryApi(dispatch), {});

    const signedIn = dispatch.mock.calls
      .map(([action]) => action as { type: string; payload?: unknown })
      .find((action) => action.type === 'session/signedIn');

    expect(signedIn?.payload).toEqual({ userId: 'user-1', roles: ['customer', 'master'] });
  });

  /**
   * The acceptance criterion the whole design turns on.
   *
   * Without deduplication each of these five requests would present the same
   * refresh token, four of them after it had already been spent — which the
   * server's reuse detection reads as a stolen credential being replayed, and
   * answers by revoking every session the user holds (issue #26). The bug
   * would present to the user as being signed out of all their devices for
   * opening a busy screen.
   */
  it('makes exactly one refresh request for five concurrent 401s', async () => {
    const { log, fetchFn } = transport({ delayMs: 5 });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);
    const api = baseQueryApi(dispatch);

    const results = await Promise.all(
      // `Promise.resolve` because a base query may answer synchronously, and
      // `Promise.all` over a mixed iterable is what the lint rule objects to.
      ['/orders', '/masters', '/services', '/profile', '/notifications'].map((path) =>
        Promise.resolve(baseQuery(path, api, {})),
      ),
    );

    const refreshes = log.filter((entry) => entry.path === '/auth/refresh');
    expect(refreshes).toHaveLength(1);

    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.data).toEqual({ ok: true });
    }
  });

  it('does not refresh when another request already did', async () => {
    const { log, fetchFn } = transport();
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    // First call refreshes; the token in the store is now the new one.
    await baseQuery('/orders', baseQueryApi(dispatch), {});
    const afterFirst = log.length;

    // A request that was already on the wire with the old token, arriving
    // late. Rotating again would spend a token that was just minted.
    await baseQuery('/orders', baseQueryApi(dispatch), {});

    expect(log.slice(afterFirst).filter((entry) => entry.path === '/auth/refresh')).toHaveLength(0);
  });

  it('signs the user out and clears the tokens when the refresh is refused', async () => {
    const { fetchFn } = transport({ refreshStatus: 401 });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/orders', baseQueryApi(dispatch), {});

    expect(result.error?.status).toBe(401);
    expect(dispatchedTypes(dispatch)).toContain('session/signedOut');
    expect(tokens.getAccessToken()).toBeNull();
    await expect(tokens.getRefreshToken()).resolves.toBeNull();
  });

  it('keeps the session when the refresh could not be reached', async () => {
    const { fetchFn } = transport({ refreshStatus: 503 });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/orders', baseQueryApi(dispatch), {});

    // The caller sees its original 401 and the session survives to be
    // refreshed when the network comes back.
    expect(result.error?.status).toBe(401);
    expect(dispatchedTypes(dispatch)).not.toContain('session/signedOut');
    await expect(tokens.getRefreshToken()).resolves.toBe('row-1.secret');
  });

  it('does not refresh a 401 on a request that carried no token', async () => {
    const { log, fetchFn } = transport();
    const tokens = fakeTokenStore(null, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/auth/otp/verify', baseQueryApi(dispatch), {});

    // A public endpoint refusing is not an expired session; trading the
    // refresh token here would spend it for nothing.
    expect(result.error?.status).toBe(401);
    expect(log.filter((entry) => entry.path === '/auth/refresh')).toHaveLength(0);
  });

  it('ends the session when a freshly minted token is refused as well', async () => {
    // The refresh succeeds but hands back a token the API still rejects —
    // a suspended account, or a session revoked between the two calls.
    const { fetchFn } = transport({ mintedAccess: 'a-token-the-api-will-not-accept' });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery('/orders', baseQueryApi(dispatch), {});

    expect(result.error?.status).toBe(401);
    expect(dispatchedTypes(dispatch)).toContain('session/signedOut');
    expect(tokens.getAccessToken()).toBeNull();
  });

  it('passes a non-401 failure straight through without refreshing', async () => {
    const { log, fetchFn } = transport({ apiStatus: 422 });
    const tokens = fakeTokenStore(FIRST_ACCESS, 'row-1.secret');
    const { baseQuery, dispatch } = build(tokens, fetchFn);

    const result = await baseQuery(
      { url: '/orders', method: 'POST', body: {} },
      baseQueryApi(dispatch),
      {},
    );

    // A rejected body is not an expired token, and refreshing would spend a
    // rotation on a request that is going to fail again anyway.
    expect(result.error?.status).toBe(422);
    expect(log.filter((entry) => entry.path === '/auth/refresh')).toHaveLength(0);
    expect(dispatchedTypes(dispatch)).not.toContain('session/signedOut');
  });
});
