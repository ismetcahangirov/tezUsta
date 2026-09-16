import * as SecureStore from 'expo-secure-store';

import { SECURE_KEYS } from '../lib/secure-store';
import { createAppStore, type AppStore } from '../store';
import {
  selectAuthStatus,
  selectGrantedRoles,
  selectOtpRequestedFor,
} from '../store/session-slice';

import { authApi } from './auth-endpoints';
import { tokenStore } from './token-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const secureStore = jest.mocked(SecureStore);

const ACCESS_TOKEN = `header.${Buffer.from(
  JSON.stringify({ sub: 'user-1', roles: ['customer', 'master'] }),
).toString('base64url')}.signature`;
const REFRESH_TOKEN = 'row-1.a-secret-nobody-should-ever-see-in-a-log';

const PAIR = {
  accessToken: ACCESS_TOKEN,
  accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
  refreshToken: REFRESH_TOKEN,
  refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
};

interface Call {
  readonly path: string;
  readonly authorization: string | null;
}

let calls: Call[] = [];
let logoutStatus = 204;

/**
 * Stands in for the API on the global `fetch`, which is what the api slice
 * resolves per request — so this drives the real slice, the real base query
 * and the real token store, with only the keychain and the network faked.
 */
function installTransport(): void {
  calls = [];

  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const path = request.url.replace('http://api.test', '');

    calls.push({ path, authorization: request.headers.get('Authorization') });

    if (path === '/auth/otp/request') {
      return Promise.resolve(new Response(null, { status: 202 }));
    }

    if (path === '/auth/otp/verify') {
      return Promise.resolve(
        new Response(JSON.stringify(PAIR), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    if (path === '/auth/logout' || path === '/auth/logout-all') {
      return Promise.resolve(
        logoutStatus === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
              status: logoutStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
      );
    }

    return Promise.resolve(new Response(null, { status: 404 }));
  }) as unknown as typeof fetch;
}

/**
 * Waits for an endpoint's `onQueryStarted` to finish.
 *
 * `initiate()` resolves when the **request** settles; the lifecycle handler
 * that writes the keychain and dispatches `signedOut` continues past that
 * point. That gap is real and harmless in the app — the UI reads the store,
 * which settles a microtask later — but a test that asserted without waiting
 * would fail for a reason that has nothing to do with what it is checking.
 */
async function lifecycles(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function signIn(store: AppStore): Promise<void> {
  await store.dispatch(
    authApi.endpoints.verifyOtp.initiate({ phone: '+994501234567', code: '123456' }),
  );
  await lifecycles();
}

describe('the authentication endpoints', () => {
  let store: AppStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue(null);
    logoutStatus = 204;
    installTransport();
    await tokenStore.clear();
    store = createAppStore();
  });

  it('records the number an OTP was sent to, without putting it in a route', async () => {
    await store.dispatch(authApi.endpoints.requestOtp.initiate({ phone: '+994501234567' }));
    await lifecycles();

    // A route parameter would put a full phone number into a deep-linkable
    // URL and, on the web output, into browser history (CLAUDE.md §11).
    expect(selectOtpRequestedFor(store.getState())).toBe('+994501234567');
  });

  it('starts a session from a verified code', async () => {
    await signIn(store);

    expect(selectAuthStatus(store.getState())).toBe('signed-in');
    expect(selectGrantedRoles(store.getState())).toEqual(['customer', 'master']);
  });

  it('puts the refresh token in the keychain and the access token in memory', async () => {
    await signIn(store);

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken, REFRESH_TOKEN);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAccessToken()).toBe(ACCESS_TOKEN);
  });

  it('sends the access token on the sign-out request, then clears it', async () => {
    await signIn(store);

    await store.dispatch(authApi.endpoints.signOut.initiate());
    await lifecycles();

    const logout = calls.find((call) => call.path === '/auth/logout');
    expect(logout?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken);
    expect(selectAuthStatus(store.getState())).toBe('signed-out');
  });

  it('clears the device even when the server could not be told', async () => {
    await signIn(store);
    logoutStatus = 500;

    await store.dispatch(authApi.endpoints.signOut.initiate());
    await lifecycles();

    // A user who taps sign out on a train has asked for their tokens to be off
    // the device. Leaving a live refresh token in the keychain of a phone they
    // may be about to sell is not an acceptable answer to a failed request.
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(SECURE_KEYS.refreshToken);
    expect(selectAuthStatus(store.getState())).toBe('signed-out');
  });

  it('signs out of every device through its own endpoint', async () => {
    await signIn(store);

    await store.dispatch(authApi.endpoints.signOutEverywhere.initiate());
    await lifecycles();

    expect(calls.some((call) => call.path === '/auth/logout-all')).toBe(true);
    expect(selectAuthStatus(store.getState())).toBe('signed-out');
  });

  it('drops the previous user’s cached data on sign-out', async () => {
    await signIn(store);

    await store.dispatch(authApi.endpoints.signOut.initiate());
    await lifecycles();

    // Keeping it would show one person's orders to the next person who signs
    // in on this device.
    const state = store.getState();
    expect(Object.keys(state.api.queries)).toHaveLength(0);
    expect(Object.keys(state.api.mutations)).toHaveLength(0);
  });
});

describe('logging', () => {
  let store: AppStore;
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies: jest.SpyInstance[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue(null);
    logoutStatus = 204;
    installTransport();
    await tokenStore.clear();
    store = createAppStore();

    spies.length = 0;
    for (const method of consoleMethods) {
      spies.push(jest.spyOn(console, method).mockImplementation(() => undefined));
    }
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  /**
   * A token in a log is a token in a crash report, a log aggregator, and
   * whatever a developer pastes into an issue (CLAUDE.md §11). The assertion
   * is over every argument of every console call, because the usual way one
   * escapes is not a deliberate `console.log(token)` but an object logged
   * whole that happens to contain one.
   */
  it('never writes a token to the console', async () => {
    await store.dispatch(authApi.endpoints.requestOtp.initiate({ phone: '+994501234567' }));
    await signIn(store);
    await store.dispatch(authApi.endpoints.signOut.initiate());
    await lifecycles();

    const written = spies
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .flat()
      .map((argument) => {
        try {
          return typeof argument === 'string' ? argument : JSON.stringify(argument);
        } catch {
          return String(argument);
        }
      })
      .join('\n');

    expect(written).not.toContain(REFRESH_TOKEN);
    expect(written).not.toContain(ACCESS_TOKEN);
  });
});
