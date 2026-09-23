import { render } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import type { TokenStore } from '../auth/token-store';
import type { AppStore } from '../store';
import { signedIn, signedOut } from '../store/session-slice';

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

async function mount(token: () => string | null = () => 'token-1'): Promise<Mounted> {
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
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
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
});
