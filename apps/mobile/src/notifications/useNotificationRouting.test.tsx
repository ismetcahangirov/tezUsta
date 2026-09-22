import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { selectRole, signedIn, signedOut } from '../store/session-slice';
import { useNotificationRouting } from './useNotificationRouting';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockReplace = jest.fn();
/** One object for the file, matching expo-router's own singleton (see `useAuthGuard.test.tsx`). */
const mockRouter = { replace: mockReplace };
/** `undefined` is expo-router's "the navigator has not mounted yet". */
const mockNavigation: { state: { key: string } | undefined } = { state: { key: 'root' } };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useRootNavigationState: () => mockNavigation.state,
}));

/** The tap callback the hook handed to the adapter, so a test can fire one. */
const mockTaps: { deliver: ((data: unknown) => void) | null; forgotten: number } = {
  deliver: null,
  forgotten: 0,
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
}));

const ACCEPTED = { kind: 'order-accepted', orderId: 'order-1' };
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
    mockTaps.deliver = null;
    mockTaps.forgotten = 0;
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
});
