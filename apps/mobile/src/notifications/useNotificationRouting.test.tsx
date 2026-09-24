import type { Call } from '@tezusta/types';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { selectRingingCall } from '../calls/ringing-call-slice';
import type { AppStore } from '../store';
import { selectRole, signedIn, signedOut } from '../store/session-slice';
import { useNotificationRouting } from './useNotificationRouting';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockReplace = jest.fn();
const mockPush = jest.fn();
/** One object for the file, matching expo-router's own singleton (see `useAuthGuard.test.tsx`). */
const mockRouter = { replace: mockReplace, push: mockPush };
/** `undefined` is expo-router's "the navigator has not mounted yet". */
const mockNavigation: { state: { key: string } | undefined } = { state: { key: 'root' } };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useRootNavigationState: () => mockNavigation.state,
}));

/** The tap callback the hook handed to the adapter, so a test can fire one. */
const mockTaps: {
  deliver: ((data: unknown) => void) | null;
  arrive: ((data: unknown) => void) | null;
  forgotten: number;
  dismissed: string[];
} = {
  deliver: null,
  arrive: null,
  forgotten: 0,
  dismissed: [],
};

jest.mock('./push-adapter', () => ({
  subscribeToNotificationTaps: (onTap: (data: unknown) => void) => {
    mockTaps.deliver = onTap;
    return {
      remove: () => {
        mockTaps.deliver = null;
      },
    };
  },
  forgetLastNotificationTap: () => {
    mockTaps.forgotten += 1;
  },
  subscribeToForegroundNotifications: (onReceive: (data: unknown) => void) => {
    mockTaps.arrive = onReceive;
    return {
      remove: () => {
        mockTaps.arrive = null;
      },
    };
  },
  dismissCallNotifications: (callId: string) => {
    mockTaps.dismissed.push(callId);
    return Promise.resolve();
  },
}));

// Calling ships dark; the ring tests below switch it on, everything else runs
// exactly as it did before #189.
let mockCallingEnabled = false;
jest.mock('../calls/calling-enabled', () => ({
  get CALLING_ENABLED() {
    return mockCallingEnabled;
  },
}));

const ACCEPTED = { kind: 'order-accepted', orderId: 'order-1' };

/** A ring push as the server sends it: ids only (#189). */
const RING = { kind: 'call-incoming', orderId: 'order-1', callId: 'call-1' };

function serverCall(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    orderId: 'order-1',
    status: 'RINGING',
    endReason: null,
    role: 'callee',
    peer: { kind: 'master', displayName: 'Elvin' },
    startedAt: '2026-09-24T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    ...overrides,
  };
}

/** What `GET /calls/:callId` answers, and every call id it was asked about. */
let callReply: { status: number; body: unknown } = { status: 404, body: {} };
let callsRequested: string[] = [];

function installCallTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/calls/')) {
      callsRequested.push(pathname);
      return Promise.resolve(
        new Response(JSON.stringify(callReply.body), {
          status: callReply.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

async function arrive(payload: unknown): Promise<void> {
  await act(() => {
    mockTaps.arrive?.(payload);
  });
}
const OFFER = { kind: 'order-offer', orderId: 'order-1' };

function mount(store: AppStore): Promise<unknown> {
  return renderHook(
    () => {
      useNotificationRouting();
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      ),
    },
  );
}

/**
 * `act` returns a promise in this version of the library, so every call has to
 * be awaited — an unawaited one leaves the state update unflushed and the test
 * asserts against a render that never happened.
 */
async function tap(payload: unknown): Promise<void> {
  await act(() => {
    mockTaps.deliver?.(payload);
  });
}

/**
 * Where a customer's order notification now lands (#155). Before the order
 * screen existed this was the customer home, because the id had nowhere to go.
 */
const CUSTOMER_ORDER_HREF = {
  pathname: '/(customer)/order/[id]',
  params: { id: 'order-1' },
};

describe('useNotificationRouting', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPush.mockClear();
    mockTaps.deliver = null;
    mockTaps.arrive = null;
    mockTaps.forgotten = 0;
    mockTaps.dismissed = [];
    mockCallingEnabled = false;
    callsRequested = [];
    callReply = { status: 404, body: { code: 'NOT_FOUND', message: '' } };
    installCallTransport();
    mockNavigation.state = { key: 'root' };
  });

  it('opens the role experience a tap is about, from the background', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap(ACCEPTED);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
    });
  });

  it('waits for the session before navigating on a cold start', async () => {
    // The response is delivered while the app is still `restoring` — which is
    // the real cold-start order, and the case that bounces users to sign-in
    // when it is not handled.
    const store = createTestStore();
    await mount(store);

    await tap(ACCEPTED);

    expect(mockReplace).not.toHaveBeenCalled();

    await act(() => {
      store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
    });
  });

  it('waits for the navigator before navigating', async () => {
    mockNavigation.state = undefined;
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    const { rerender } = (await mount(store)) as { rerender: (props: unknown) => Promise<void> };

    await tap(ACCEPTED);

    expect(mockReplace).not.toHaveBeenCalled();

    mockNavigation.state = { key: 'root' };
    await act(async () => {
      await rerender(undefined);
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
    });
  });

  it('keeps the destination across a sign-in', async () => {
    const store = createTestStore();
    store.dispatch(signedOut());
    await mount(store);

    await tap(OFFER);

    expect(mockReplace).not.toHaveBeenCalled();

    await act(() => {
      store.dispatch(signedIn({ userId: 'user-1', roles: ['master'] }));
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(master)');
    });
  });

  it('switches the selected role into the one the notification is about', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer', 'master'] }));
    await mount(store);

    await tap(OFFER);

    await waitFor(() => {
      expect(selectRole(store.getState())).toBe('master');
    });
    expect(mockReplace).toHaveBeenCalledWith('/(master)');
  });

  /** #227: tapping the review reminder opens the review screen, not the order. */
  it('opens the review screen when the review reminder is tapped', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['master'] }));
    await mount(store);

    await tap({ kind: 'review-reminder', orderId: 'order-1' });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/(master)/review/[orderId]',
        params: { orderId: 'order-1' },
      });
    });
  });

  it('does not navigate for a kind it does not know', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap({ kind: 'order-invoiced', orderId: 'order-1' });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not navigate to a path carried in the payload', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap({ url: 'https://example.com/steal', path: '/(master)' });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not open a role the account does not hold', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap(OFFER);

    await waitFor(() => {
      expect(mockTaps.forgotten).toBe(1);
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('forgets the stored tap so a remount does not navigate again', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap(ACCEPTED);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    expect(mockTaps.forgotten).toBe(1);
  });

  it('acts on a tap once, not on every later render', async () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    await mount(store);

    await tap(ACCEPTED);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });

    await act(() => {
      store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  /**
   * The ring push (#189, ADR-0039 § 4): a wake-up, confirmed with the server
   * before anything rings. The payload's ids are only what the app asks about.
   */
  describe('a ring push', () => {
    const INCOMING_HREF = { pathname: '/call/incoming/[callId]', params: { callId: 'call-1' } };

    async function signedInCustomer(): Promise<AppStore> {
      const store = createTestStore();
      store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
      await mount(store);
      return store;
    }

    it('is routed to the order, unconfirmed, while calling ships dark', async () => {
      await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      expect(callsRequested).toEqual([]);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('opens the incoming screen once the server says it is still ringing this account', async () => {
      mockCallingEnabled = true;
      callReply = { status: 200, body: serverCall() };
      const store = await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(INCOMING_HREF);
      });
      expect(callsRequested).toEqual(['/calls/call-1']);
      expect(selectRingingCall(store.getState())).toEqual(serverCall());
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('opens the order, not a ring, for a push that landed after the call ended', async () => {
      mockCallingEnabled = true;
      callReply = {
        status: 200,
        body: serverCall({
          status: 'CANCELLED',
          endReason: 'cancelled',
          endedAt: '2026-09-24T10:00:20.000Z',
        }),
      };
      const store = await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      expect(mockPush).not.toHaveBeenCalled();
      expect(selectRingingCall(store.getState())).toBeNull();
      expect(mockTaps.dismissed).toEqual(['call-1']);
    });

    it('opens no ring for a call this account placed', async () => {
      mockCallingEnabled = true;
      callReply = { status: 200, body: serverCall({ role: 'caller' }) };
      await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('opens no ring when the server does not know the call for this account', async () => {
      mockCallingEnabled = true;
      await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('opens no ring for a call on another order than the push named', async () => {
      mockCallingEnabled = true;
      callReply = { status: 200, body: serverCall({ orderId: 'order-9' }) };
      await signedInCustomer();

      await tap(RING);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it.each([
      ['no call id', { kind: 'call-incoming', orderId: 'order-1' }],
      [
        'a path for a call id',
        { kind: 'call-incoming', orderId: 'order-1', callId: '../orders/x' },
      ],
      ['a number for a call id', { kind: 'call-incoming', orderId: 'order-1', callId: 7 }],
    ])('ignores a ring with %s: no request, no navigation', async (_what, payload) => {
      mockCallingEnabled = true;
      await signedInCustomer();

      await tap(payload);

      expect(callsRequested).toEqual([]);
      expect(mockReplace).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('rings in-app for a ring push that arrives while the app is open', async () => {
      mockCallingEnabled = true;
      callReply = { status: 200, body: serverCall() };
      await signedInCustomer();

      await arrive(RING);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(INCOMING_HREF);
      });
    });

    it('navigates nowhere for a ring push that arrives after its call ended', async () => {
      mockCallingEnabled = true;
      callReply = {
        status: 200,
        body: serverCall({ status: 'TIMED_OUT', endReason: 'no_answer' }),
      };
      await signedInCustomer();

      await arrive(RING);

      await waitFor(() => {
        expect(mockTaps.dismissed).toEqual(['call-1']);
      });
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('ignores other notifications that arrive while the app is open', async () => {
      mockCallingEnabled = true;
      await signedInCustomer();

      await arrive(ACCEPTED);

      expect(mockReplace).not.toHaveBeenCalled();
      expect(callsRequested).toEqual([]);
    });
    it('never lets a ring arriving in the foreground overwrite a held tap', async () => {
      mockCallingEnabled = true;
      callReply = { status: 200, body: serverCall() };
      const store = createTestStore();
      await mount(store);

      // A cold-start tap is held while the session is restored…
      await tap(ACCEPTED);
      // …and a ring arrives before it is released.
      await arrive(RING);
      expect(mockReplace).not.toHaveBeenCalled();

      await act(() => {
        store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
      });

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(CUSTOMER_ORDER_HREF);
      });
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(INCOMING_HREF);
      });
    });
  });
});
