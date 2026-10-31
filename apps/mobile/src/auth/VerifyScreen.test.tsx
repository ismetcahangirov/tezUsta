import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import VerifyScreen from '../../app/(auth)/verify';
import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { otpRequested, selectAuthStatus, selectOtpRequestedFor } from '../store/session-slice';

import { resolveAuthRedirect } from './route-guard';
import { tokenStore } from './token-store';

/**
 * Issue #71: a valid code returned the user to the sign-in screen.
 *
 * **Not co-located with the screen**, and that is not a lapse of CLAUDE.md §4.
 * `apps/mobile/app` is expo-router's route directory and every `.tsx` under it
 * becomes a route — the ignore pattern in `expo-router/_ctx.js` excludes only
 * `+html` and `+api` files, so a `verify.test.tsx` next to `verify.tsx` would
 * ship a `/(auth)/verify.test` route into the app. The screen is imported from
 * here instead.
 *
 * What is asserted is the store and the route the guard resolves from it,
 * rather than a navigator: the bug was never about pixels, and mounting a real
 * navigator to observe it would test expo-router instead of this app.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

/**
 * `Redirect` records where it was asked to send the user instead of navigating.
 * It is the component under suspicion, so it has to be observable rather than
 * merely inert.
 */
const mockRedirects: string[] = [];

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirects.push(href);
    return null;
  },
}));

/**
 * `waitFor` defaults to one second, which is a budget this suite spends on the
 * machine rather than on the app — the same reason `jest.config.js` raises the
 * per-test timeout. Rendering a React Native tree and settling an RTK Query
 * mutation is not fast on a CI runner with the API's Postgres suites on the
 * same cores.
 */
const SETTLED = { timeout: 10_000 };

const EMAIL = 'aysel@example.az';
const CODE = '123456';

const ACCESS_TOKEN = `header.${Buffer.from(
  JSON.stringify({ sub: 'user-1', roles: ['customer'] }),
).toString('base64url')}.signature`;

const PAIR = {
  accessToken: ACCESS_TOKEN,
  accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
  refreshToken: 'row-1.a-secret-nobody-should-ever-see-in-a-log',
  refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
};

let verifyBodies: unknown[] = [];

/** Only `fetch` is faked; the real api slice, base query and reducers run. */
function installTransport(verifyStatus: number): void {
  verifyBodies = [];

  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;

    if (request.url.endsWith('/auth/otp/verify')) {
      verifyBodies.push(await request.json());
      return verifyStatus === 200
        ? new Response(JSON.stringify(PAIR), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
            status: verifyStatus,
            headers: { 'Content-Type': 'application/json' },
          });
    }

    throw new Error(`Unexpected request to ${request.url}`);
  }) as typeof fetch;
}

// `render` is asynchronous in @testing-library/react-native 14 and only
// populates `screen` once it settles; calling it without awaiting leaves every
// query throwing "`render` function has not been called".
async function mount(store: AppStore): Promise<void> {
  await render(
    <Provider store={store}>
      <VerifyScreen />
    </Provider>,
  );
}

function storeAwaitingCode(): AppStore {
  const store = createTestStore();
  store.dispatch(otpRequested(EMAIL));
  return store;
}

// `fireEvent` is asynchronous in this version too: pressing before the typed
// code has been committed presses a button that is still disabled.
async function submitCode(): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Təsdiq kodu'), CODE);
  await fireEvent.press(screen.getByRole('button', { name: 'Təsdiqlə' }));
}

describe('verifying an OTP code', () => {
  beforeEach(async () => {
    mockRedirects.length = 0;
    // `tokenStore` is a module-level singleton, so a successful verification in
    // one test leaves an access token behind for the next one — and a 401 with
    // a token in hand takes the refresh-and-replay path instead of surfacing,
    // which makes the wrong-code test depend on the order it runs in.
    await tokenStore.clear();
  });

  it('says which address the code went to', async () => {
    installTransport(200);
    await mount(storeAwaitingCode());

    expect(screen.getByText(`Kod ${EMAIL} ünvanına göndərildi.`)).toBeOnTheScreen();
  });

  it('sends the code with the address it was sent to', async () => {
    installTransport(200);
    await mount(storeAwaitingCode());

    await submitCode();

    await waitFor(() => {
      expect(verifyBodies).toEqual([{ email: EMAIL, code: CODE }]);
    }, SETTLED);
  });

  it('leaves the user signed in and out of the auth group, never back on sign-in', async () => {
    installTransport(200);
    const store = storeAwaitingCode();
    await mount(store);

    await submitCode();

    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-in');
    }, SETTLED);

    // The session cleared the pending address, which is what used to make this
    // screen think it had been deep-linked into.
    expect(selectOtpRequestedFor(store.getState())).toBeNull();
    expect(mockRedirects).toEqual([]);

    // And where the one guard that decides navigation would now send them.
    const { status, grantedRoles, role } = store.getState().session;
    expect(resolveAuthRedirect({ status, grantedRoles, role, group: '(auth)' })).toBe(
      '/(customer)',
    );
  });

  it('stays on the screen with its error when the code is wrong', async () => {
    installTransport(401);
    const store = storeAwaitingCode();
    await mount(store);

    await submitCode();

    await waitFor(() => {
      expect(screen.getByText('Kod düzgün deyil və ya vaxtı bitib.')).toBeOnTheScreen();
    }, SETTLED);

    expect(selectAuthStatus(store.getState())).not.toBe('signed-in');
    // A failed verification is not a reason to lose the address that was
    // entered — the user is meant to try the code again.
    expect(selectOtpRequestedFor(store.getState())).toBe(EMAIL);
    expect(mockRedirects).toEqual([]);
  });

  it('still sends a deep link with no pending address back to sign-in', async () => {
    installTransport(200);
    // Nothing requested a code on this device: the screen has nothing to
    // verify, and the redirect it exists for must survive the fix above.
    await mount(createTestStore());

    expect(mockRedirects).toEqual(['/(auth)/sign-in']);
  });
});
