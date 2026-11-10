import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import {
  otpRequested,
  selectAuthStatus,
  selectSignInEmailHint,
  signedIn,
  signedOut,
  signInEmailHinted,
} from '../store/session-slice';
import { EmailChange } from './EmailChange';
import { EMAIL_CHANGE_COPY as copy } from './email-change-copy';
import { emailChangeErrorMessage } from './email-change-errors';

/**
 * Changing the sign-in address from Settings (#516, ADR-0074 § 1), against
 * the API #514 built. Only `fetch` is faked; the real api slice, base query
 * and reducers run.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

/** See `VerifyScreen.test.tsx`: the budget is the machine's, not the app's. */
const SETTLED = { timeout: 10_000 };

const CURRENT = 'aysel@example.az';
const NEXT = 'aysel.new@example.az';

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

const started: Reply = { status: 200, body: { expiresInSeconds: 300, currentEmail: CURRENT } };
const confirmed: Reply = { status: 204 };

function refusal(status: number, code: string): Reply {
  return { status, body: { error: { code, message: code } } };
}

let starts: unknown[] = [];
let confirms: unknown[] = [];

/** Each call to an endpoint takes the next reply from its queue. */
function installTransport(startReplies: Reply[], confirmReplies: Reply[] = []): void {
  starts = [];
  confirms = [];

  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const path = new URL(request.url).pathname;

    let reply: Reply | undefined;
    if (path === '/me/email-change') {
      starts.push(await request.json());
      reply = startReplies.shift();
    } else if (path === '/me/email-change/confirm') {
      confirms.push(await request.json());
      reply = confirmReplies.shift();
    }
    if (reply === undefined) {
      throw new Error(`Unexpected request to ${request.url}`);
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

const onBack = jest.fn();

async function mount(): Promise<AppStore> {
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
  await render(
    <Provider store={store}>
      <EmailChange onBack={onBack} />
    </Provider>,
  );
  return store;
}

async function enterAddress(address: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText(copy.newEmailLabel), address);
  await fireEvent.press(screen.getByRole('button', { name: copy.sendCodes }));
}

async function enterCodes(current: string, next: string): Promise<void> {
  await fireEvent.changeText(
    await screen.findByLabelText(copy.codeFor(CURRENT), {}, SETTLED),
    current,
  );
  await fireEvent.changeText(screen.getByLabelText(copy.codeFor(NEXT)), next);
  await fireEvent.press(screen.getByRole('button', { name: copy.confirm }));
}

beforeEach(() => {
  onBack.mockClear();
  jest.mocked(SecureStore.deleteItemAsync).mockClear();
});

describe('changing the sign-in address', () => {
  it('sends both codes, labels each field by its address, and signs out to the new address', async () => {
    installTransport([started], [confirmed]);
    const store = await mount();

    await enterAddress('  Aysel.New@Example.AZ ');
    await enterCodes('111111', '222222');

    await waitFor(() => {
      expect(selectAuthStatus(store.getState())).toBe('signed-out');
    }, SETTLED);
    expect(starts).toEqual([{ newEmail: NEXT }]);
    // The address is the server's to hold; only the codes are sent.
    expect(confirms).toEqual([{ currentCode: '111111', newCode: '222222' }]);
    expect(selectSignInEmailHint(store.getState())).toBe(NEXT);
    // The revoked session's tokens are off the device.
    expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it('does not spend a request on something that is not an address', async () => {
    installTransport([]);
    await mount();

    await enterAddress('aysel@example');

    expect(screen.getByText(copy.errors.malformed)).toBeOnTheScreen();
    expect(starts).toEqual([]);
  });

  it.each([
    ['the same address', refusal(422, 'EMAIL_CHANGE_SAME_ADDRESS'), copy.errors.sameAddress],
    ['an address the server refuses', refusal(422, 'VALIDATION_FAILED'), copy.errors.malformed],
    ['too many starts', refusal(429, 'RATE_LIMITED'), copy.errors.tooManyAttempts],
  ])(
    'says so when the start is refused for %s, and lets the user try again',
    async (_, reply, message) => {
      installTransport([reply, started]);
      await mount();

      await enterAddress(NEXT);

      expect(await screen.findByText(message, {}, SETTLED)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: copy.sendCodes }));
      expect(await screen.findByLabelText(copy.codeFor(CURRENT), {}, SETTLED)).toBeOnTheScreen();
    },
  );

  it.each([
    ['a wrong or expired code', refusal(422, 'EMAIL_CHANGE_CODE_INVALID'), copy.errors.codeInvalid],
    ['a taken address', refusal(409, 'EMAIL_ADDRESS_TAKEN'), copy.errors.taken],
    ['too many attempts', refusal(429, 'RATE_LIMITED'), copy.errors.tooManyAttempts],
  ])('keeps the session when the confirm is refused for %s', async (_, reply, message) => {
    installTransport([started], [reply]);
    const store = await mount();

    await enterAddress(NEXT);
    await enterCodes('111111', '222222');

    expect(await screen.findByText(message, {}, SETTLED)).toBeOnTheScreen();
    expect(selectAuthStatus(store.getState())).toBe('signed-in');
    expect(selectSignInEmailHint(store.getState())).toBeNull();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    // Still able to correct a code and confirm again.
    expect(screen.getByRole('button', { name: copy.confirm })).toBeEnabled();
  });

  it('sends both codes again on request, with fresh fields', async () => {
    installTransport([started, started]);
    await mount();

    await enterAddress(NEXT);
    await fireEvent.changeText(
      await screen.findByLabelText(copy.codeFor(CURRENT), {}, SETTLED),
      '111111',
    );
    await fireEvent.press(screen.getByRole('button', { name: copy.resend }));

    expect(await screen.findByText(copy.resent, {}, SETTLED)).toBeOnTheScreen();
    expect(starts).toEqual([{ newEmail: NEXT }, { newEmail: NEXT }]);
    expect(screen.getByLabelText(copy.codeFor(CURRENT))).toHaveProp('value', '');
  });

  it('goes back to the address with what was typed, to correct it', async () => {
    installTransport([started]);
    await mount();

    await enterAddress(NEXT);
    await fireEvent.press(await screen.findByRole('button', { name: copy.changeAddress }, SETTLED));

    expect(screen.getByLabelText(copy.newEmailLabel)).toHaveProp('value', NEXT);
  });

  it('leaves without a request, and the session untouched, when the user backs out', async () => {
    installTransport([]);
    const store = await mount();

    await fireEvent.press(screen.getByRole('button', { name: copy.back }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(starts).toEqual([]);
    expect(selectAuthStatus(store.getState())).toBe('signed-in');
  });
});

describe('the refusal messages', () => {
  it('names a refused send budget, which the server answers with a 503', () => {
    // Through the screen a 5xx is retried with real backoff; the mapping is
    // what this asserts.
    expect(emailChangeErrorMessage('start', { status: 503, data: null })).toBe(
      copy.errors.sendCapReached,
    );
  });

  it('reads a non-numeric code refused by validation as a bad code, not a bad address', () => {
    expect(
      emailChangeErrorMessage('confirm', {
        status: 422,
        data: { error: { code: 'VALIDATION_FAILED' } },
      }),
    ).toBe(copy.errors.codeInvalid);
  });

  it('falls back to a generic line for anything else', () => {
    expect(emailChangeErrorMessage('confirm', { status: 'FETCH_ERROR' })).toBe(copy.errors.generic);
  });
});

describe('the address kept for sign-in', () => {
  it('survives a later sign-out and goes once a code is requested', () => {
    const store = createTestStore();
    store.dispatch(signedOut());
    store.dispatch(signInEmailHinted(NEXT));
    // Requests still in flight after the change come back 401 and sign out again.
    store.dispatch(signedOut());
    expect(selectSignInEmailHint(store.getState())).toBe(NEXT);

    store.dispatch(otpRequested(NEXT));
    expect(selectSignInEmailHint(store.getState())).toBeNull();
  });
});
