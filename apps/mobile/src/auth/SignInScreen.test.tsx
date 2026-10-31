import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import SignInScreen from '../../app/(auth)/sign-in';
import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { selectOtpRequestedFor } from '../store/session-slice';

/**
 * Sign-in asks for an email address and nothing else (ADR-0072).
 *
 * Not co-located with the screen for the reason `VerifyScreen.test.tsx` gives:
 * every `.tsx` under `apps/mobile/app` becomes a route.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const mockPush = jest.fn<void, [string]>();

jest.mock('expo-router', () => ({
  router: {
    push: (href: string) => {
      mockPush(href);
    },
  },
}));

/** See `VerifyScreen.test.tsx`: the budget is the machine's, not the app's. */
const SETTLED = { timeout: 10_000 };

const FIELD = 'E-poçt ünvanı';
const SUBMIT = 'Kod göndər';

let requestBodies: unknown[] = [];

/** Only `fetch` is faked; the real api slice, base query and reducers run. */
function installTransport(requestStatus: number): void {
  requestBodies = [];

  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;

    if (request.url.endsWith('/auth/otp/request')) {
      requestBodies.push(await request.json());
      return requestStatus === 200
        ? new Response(JSON.stringify({ expiresInSeconds: 300 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
            status: requestStatus,
            headers: { 'Content-Type': 'application/json' },
          });
    }

    throw new Error(`Unexpected request to ${request.url}`);
  }) as typeof fetch;
}

async function mount(store: AppStore): Promise<void> {
  await render(
    <Provider store={store}>
      <SignInScreen />
    </Provider>,
  );
}

async function submit(email: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText(FIELD), email);
  await fireEvent.press(screen.getByRole('button', { name: SUBMIT }));
}

describe('signing in with an email address', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('asks for an email address, with the keyboard and autofill for one', async () => {
    installTransport(200);
    await mount(createTestStore());

    const field = screen.getByLabelText(FIELD);
    expect(field).toHaveProp('keyboardType', 'email-address');
    expect(field).toHaveProp('autoCapitalize', 'none');
    expect(field).toHaveProp('autoComplete', 'email');
    expect(field).toHaveProp('textContentType', 'emailAddress');
  });

  it('sends the address trimmed and lowercased, and moves on to the code', async () => {
    installTransport(200);
    const store = createTestStore();
    await mount(store);

    await submit('  Aysel@Example.AZ ');

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/(auth)/verify');
    }, SETTLED);
    expect(requestBodies).toEqual([{ email: 'aysel@example.az' }]);
    // Held in the store for the verify screen, never in a route parameter.
    expect(selectOtpRequestedFor(store.getState())).toBe('aysel@example.az');
  });

  it('does not spend a request on something that is not an address', async () => {
    installTransport(200);
    const store = createTestStore();
    await mount(store);

    await submit('aysel@example');

    expect(screen.getByText('E-poçt ünvanı düzgün deyil.')).toBeOnTheScreen();
    expect(requestBodies).toEqual([]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(selectOtpRequestedFor(store.getState())).toBeNull();
  });

  it('stays on the screen with its error when the code could not be sent', async () => {
    // A 429 rather than a 503: a 5xx is retried with real backoff, which
    // would spend this test's budget on waiting rather than on the screen.
    installTransport(429);
    const store = createTestStore();
    await mount(store);

    await submit('aysel@example.az');

    await waitFor(() => {
      expect(screen.getByText('Kod göndərilmədi. Yenidən cəhd edin.')).toBeOnTheScreen();
    }, SETTLED);
    expect(mockPush).not.toHaveBeenCalled();
    expect(selectOtpRequestedFor(store.getState())).toBeNull();
  });
});
