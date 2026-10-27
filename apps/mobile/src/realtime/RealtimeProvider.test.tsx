import { act, render } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import type { RefreshCoordinator, RefreshOutcome } from '../auth/refresh';
import type { TokenStore } from '../auth/token-store';
import type { AppStore } from '../store';
import { selectAuthStatus, signedIn, signedOut } from '../store/session-slice';

import { selectConnectionStatus } from './connection-slice';
import { createRealtimeConnection } from './realtime-connection';
import { ROOM_JOIN } from './realtime-events';
import { RealtimeProvider } from './RealtimeProvider';
import { useRealtimeConnection } from './RealtimeProvider';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

let appStateListener: ((state: AppStateStatus) => void) | undefined;

function stubTokens(token: () => string | null): TokenStore {
  return {
    getAccessToken: token,
    getRefreshToken: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

interface Mounted {
  readonly store: AppStore;
  readonly sockets: FakeSocketFactory;
  /** Joins a room from inside the tree, the way a screen does. */
  joinFromScreen(): void;
}

async function mount(
  token: () => string | null = () => 'token-1',
  coordinator?: RefreshCoordinator,
): Promise<Mounted> {
  const sockets = createFakeSocketFactory();
  const store = createTestStore();
  let join: (() => void) | undefined;

  function Screen(): React.JSX.Element {
    const connection = useRealtimeConnection();
    join = () => connection?.join({ kind: 'order', orderId: 'order-1' });
    return <Text>screen</Text>;
  }

  await render(
    <Provider store={store}>
      <RealtimeProvider
        tokens={stubTokens(token)}
        {...(coordinator === undefined ? {} : { coordinator })}
        createConnection={(options) =>
          // The low end of the jitter, so a manual reconnection (#468) waits
          // half a second rather than up to one and a half.
          createRealtimeConnection({ ...options, createSocket: sockets.factory, random: () => 0 })
        }
      >
        <Screen />
      </RealtimeProvider>
    </Provider>,
  );

  return {
    store,
    sockets,
    joinFromScreen: () => {
      join?.();
    },
  };
}

async function signIn(store: AppStore): Promise<void> {
  await actAndSettle(() => {
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
  });
}

/**
 * The app's one connection, opened and closed by the session and the app
 * lifecycle (issue #170).
 *
 * Every test asserts what the transport was asked to do, not how the provider
 * is written: whether a socket exists, what token it presented, and what the
 * app is honestly able to say about it.
 */
describe('the realtime provider', () => {
  beforeEach(() => {
    appStateListener = undefined;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event: string, listener: (state: AppStateStatus) => void) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens no socket before there is a session', async () => {
    const { sockets, store } = await mount();

    expect(sockets.sockets).toHaveLength(0);
    expect(selectConnectionStatus(store.getState())).toBe('offline');
  });

  it('opens one when the user signs in, and says so', async () => {
    const { sockets, store } = await mount();

    await signIn(store);

    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.latest().tokensPresented).toEqual(['token-1']);
    expect(selectConnectionStatus(store.getState())).toBe('connecting');

    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });
    expect(selectConnectionStatus(store.getState())).toBe('live');
  });

  it('closes it on sign-out and reports offline', async () => {
    const { sockets, store } = await mount();
    await signIn(store);
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    await actAndSettle(() => {
      store.dispatch(signedOut());
    });

    expect(sockets.latest().disconnectCalls).toBe(1);
    expect(selectConnectionStatus(store.getState())).toBe('offline');
  });

  /**
   * **A second account must not inherit the first one's subscriptions.** The
   * sign-out resets the wanted rooms, so the socket the next sign-in opens
   * joins nothing until a screen asks — and presents the token that account
   * actually holds.
   */
  it('does not reuse the previous account’s connection or rooms', async () => {
    let token = 'token-first';
    const { sockets, store } = await mount(() => token);
    await signIn(store);
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });
    const first = sockets.latest();

    await actAndSettle(() => {
      store.dispatch(signedOut());
    });
    token = 'token-second';
    await signIn(store);
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.latest()).not.toBe(first);
    expect(sockets.latest().tokensPresented).toEqual(['token-second']);
    expect(sockets.latest().emitted).toEqual([]);
  });

  /**
   * React Native freezes the JS thread in the background, so a socket
   * "surviving" an hour in a pocket is a screen that looks live and is not.
   * What must survive is the *subscription*, so coming back resubscribes and
   * refetches rather than going quiet.
   */
  it('drops the socket in the background and resubscribes on return', async () => {
    const { sockets, store } = await mount();
    await signIn(store);
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    await actAndSettle(() => {
      appStateListener?.('background');
    });
    expect(selectConnectionStatus(store.getState())).toBe('offline');

    await actAndSettle(() => {
      appStateListener?.('active');
    });
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    expect(sockets.sockets).toHaveLength(2);
    expect(selectConnectionStatus(store.getState())).toBe('live');
  });

  it('re-joins the rooms a screen asked for after a background', async () => {
    const mounted = await mount();
    await signIn(mounted.store);
    await actAndSettle(() => {
      mounted.sockets.latest().serverConnect();
    });
    await actAndSettle(() => {
      mounted.joinFromScreen();
    });

    await actAndSettle(() => {
      appStateListener?.('background');
    });
    await actAndSettle(() => {
      appStateListener?.('active');
    });
    await actAndSettle(() => {
      mounted.sockets.latest().serverConnect();
    });

    expect(mounted.sockets.latest().emitted).toEqual([
      { event: ROOM_JOIN, payload: { kind: 'order', orderId: 'order-1' } },
    ]);
  });

  /**
   * Issue #468, end to end through the provider: the API closes the socket at
   * the token's `exp`, and the app renews the token through the shared
   * coordinator and dials again with the new one — without a background.
   */
  describe('when the server closes the socket at token expiry', () => {
    /** A token whose `exp` has already passed, by this machine's clock. */
    const EXPIRED = tokenExpiringAt(Date.now() - 1_000);
    const RENEWED = tokenExpiringAt(Date.now() + 15 * 60_000);
    /** Past the longest first wait with `random: () => 0`. */
    const AFTER_BACKOFF_MS = 600;

    function tokenExpiringAt(epochMs: number): string {
      const segment = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${segment({ alg: 'HS256' })}.${segment({ sub: 'user-1', exp: Math.floor(epochMs / 1_000) })}.sig`;
    }

    async function closeAtExpiry(outcome: RefreshOutcome): Promise<{
      readonly mounted: Mounted;
      readonly refreshes: () => number;
    }> {
      let token = EXPIRED;
      let refreshes = 0;
      const coordinator: RefreshCoordinator = {
        refresh: () => {
          refreshes += 1;
          if (outcome.status === 'refreshed') {
            token = RENEWED;
          }
          return Promise.resolve(outcome);
        },
      };
      const mounted = await mount(() => token, coordinator);
      await signIn(mounted.store);
      await actAndSettle(() => {
        mounted.sockets.latest().serverConnect();
      });

      await actAndSettle(() => {
        mounted.sockets.latest().serverClose();
      });
      // Inside `act`: the refresh lands during this wait and dispatches.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, AFTER_BACKOFF_MS);
        });
      });

      return { mounted, refreshes: () => refreshes };
    }

    it('renews the token and dials again with the new one', async () => {
      const { mounted, refreshes } = await closeAtExpiry({
        status: 'refreshed',
        identity: { userId: 'user-1', roles: ['customer'] },
      });

      expect(refreshes()).toBe(1);
      expect(mounted.sockets.sockets).toHaveLength(1);
      expect(mounted.sockets.latest().tokensPresented).toEqual([EXPIRED, RENEWED]);
      expect(selectConnectionStatus(mounted.store.getState())).toBe('reconnecting');
    });

    it('signs out, and dials nothing, when the refresh token is refused', async () => {
      const { mounted } = await closeAtExpiry({ status: 'rejected' });

      expect(selectAuthStatus(mounted.store.getState())).toBe('signed-out');
      expect(mounted.sockets.latest().tokensPresented).toEqual([EXPIRED]);
      expect(selectConnectionStatus(mounted.store.getState())).toBe('offline');
    });
  });
});
