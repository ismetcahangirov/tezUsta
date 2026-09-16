import * as SecureStore from 'expo-secure-store';

import { SECURE_KEYS } from '../lib/secure-store';

import { createRefreshCoordinator } from './refresh';
import { tokenStore } from './token-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const secureStore = jest.mocked(SecureStore);

const BASE_URL = 'http://api.test';

function accessTokenFor(roles: string[], userId = 'user-1'): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, roles })).toString('base64url');
  return `header.${payload}.signature`;
}

function newPair(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    accessToken,
    accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
    refreshToken,
    refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
  });
}

/**
 * Drives the real coordinator against the **real** token store with a mocked
 * keychain, so "the stored token was cleared" means the keychain was actually
 * told to delete it rather than that a fake object updated a field.
 */
function harness(respond: () => Promise<Response>): {
  refreshes: () => number;
  coordinator: ReturnType<typeof createRefreshCoordinator>;
} {
  let refreshes = 0;

  const fetchFn = ((): Promise<Response> => {
    refreshes += 1;
    return respond();
  }) as unknown as typeof fetch;

  return {
    refreshes: () => refreshes,
    coordinator: createRefreshCoordinator({ baseUrl: BASE_URL, fetchFn }),
  };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('refreshing a session', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue('row-1.secret');
    await tokenStore.clear();
    jest.clearAllMocks();
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue('row-1.secret');
  });

  it('stores the new pair and reports the identity it carries', async () => {
    const { coordinator } = harness(() =>
      Promise.resolve(
        jsonResponse(newPair(accessTokenFor(['customer', 'master']), 'row-2.secret')),
      ),
    );

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({
      status: 'refreshed',
      identity: { userId: 'user-1', roles: ['customer', 'master'] },
    });
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken, 'row-2.secret');
  });

  /**
   * The test this whole module exists for.
   *
   * Five concurrent callers must produce **one** rotation. Five would present
   * the same spent refresh token five times, and the server reads a replayed
   * spent token as a stolen credential and revokes the entire session family —
   * signing the user out of every device they own
   * (docs/architecture/authentication.md § Refresh rotation with reuse
   * detection). "At least one" is not the assertion; exactly one is.
   */
  it('makes exactly one request for five concurrent callers', async () => {
    const { coordinator, refreshes } = harness(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(jsonResponse(newPair(accessTokenFor(['customer']), 'row-2.secret'))),
            5,
          );
        }),
    );

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => coordinator.refresh()));

    expect(refreshes()).toBe(1);
    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('refreshed');
    }
  });

  it('gives every concurrent caller the same result', async () => {
    const { coordinator } = harness(() =>
      Promise.resolve(jsonResponse(newPair(accessTokenFor(['master']), 'row-2.secret'))),
    );

    const [first, second] = await Promise.all([coordinator.refresh(), coordinator.refresh()]);

    expect(first).toEqual(second);
  });

  it('refreshes again after the first one has finished', async () => {
    const { coordinator, refreshes } = harness(() =>
      Promise.resolve(jsonResponse(newPair(accessTokenFor(['customer']), 'row-2.secret'))),
    );

    await coordinator.refresh();
    await coordinator.refresh();

    // Not a reuse: the second call presents the token the first one minted.
    // Sharing the promise forever would mean a session could never be
    // refreshed twice.
    expect(refreshes()).toBe(2);
  });

  it('never leaves a shared promise behind after a failure', async () => {
    const { coordinator, refreshes } = harness(() => Promise.reject(new Error('offline')));

    await coordinator.refresh();
    await coordinator.refresh();

    expect(refreshes()).toBe(2);
  });

  it('rejects the session and clears the keychain when the server refuses', async () => {
    const { coordinator } = harness(() =>
      Promise.resolve(jsonResponse(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), 401)),
    );

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({ status: 'rejected' });
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken);
    expect(tokenStore.getAccessToken()).toBeNull();
  });

  it('keeps the refresh token when the request never got an answer', async () => {
    const { coordinator } = harness(() => Promise.reject(new TypeError('Network request failed')));

    const outcome = await coordinator.refresh();

    // Throwing away a 30-day credential because a train went into a tunnel
    // would make the user re-authenticate by SMS for a fault that was not
    // theirs.
    expect(outcome).toEqual({ status: 'unavailable' });
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('keeps the refresh token when the API is down', async () => {
    const { coordinator } = harness(() => Promise.resolve(jsonResponse('{}', 503)));

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('keeps the refresh token when the response body will not parse', async () => {
    const { coordinator } = harness(() => Promise.resolve(jsonResponse('<html>gateway</html>')));

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('does not call the API at all when there is nothing to present', async () => {
    secureStore.getItemAsync.mockResolvedValue(null);
    const { coordinator, refreshes } = harness(() => Promise.resolve(jsonResponse('{}')));

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({ status: 'rejected' });
    expect(refreshes()).toBe(0);
  });

  it('presents the refresh token without an Authorization header', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchFn = ((url: string, init: RequestInit): Promise<Response> => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(jsonResponse(newPair(accessTokenFor(['customer']), 'row-2.secret')));
    }) as unknown as typeof fetch;

    await createRefreshCoordinator({ baseUrl: BASE_URL, fetchFn }).refresh();

    expect(seen.url).toBe('http://api.test/auth/refresh');
    expect(seen.init?.body).toBe(JSON.stringify({ refreshToken: 'row-1.secret' }));
    // `/auth/refresh` is a public route, and the access token it is being
    // called to replace is expired anyway. Sending one would be noise the
    // server has to decide to ignore.
    expect(seen.init?.headers).not.toHaveProperty('Authorization');
  });

  it('reports no identity when the new access token cannot be read', async () => {
    const { coordinator } = harness(() =>
      Promise.resolve(jsonResponse(newPair('not-a-jwt', 'row-2.secret'))),
    );

    const outcome = await coordinator.refresh();

    expect(outcome).toEqual({ status: 'refreshed', identity: null });
  });
});
