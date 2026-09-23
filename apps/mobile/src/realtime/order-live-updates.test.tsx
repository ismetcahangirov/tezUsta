import type { Address, Order, OrderTransitionRealtimeEvent, Service } from '@tezusta/types';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { OrderDetail } from '../orders/OrderDetail';
import { ORDERS_COPY as copy } from '../orders/orders-copy';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';

import { createRealtimeConnection } from './realtime-connection';
import { ORDER_TRANSITION_EVENT } from './realtime-events';
import { RealtimeProvider } from './RealtimeProvider';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const SERVICE_ID = 'svc-1';

const SERVICE = {
  id: SERVICE_ID,
  categoryId: 'cat-1',
  slug: 'kran-temiri',
  name: 'Kran təmiri',
  description: null,
  pricing: { kind: 'fixed', basePriceMinor: 1500, currency: 'AZN' },
  displayOrder: 1,
} as unknown as Service;

const HOME = {
  id: 'addr-1',
  label: 'Ev',
  formattedAddress: 'Nizami küçəsi 203',
  building: '12B',
  entrance: null,
  floor: null,
  apartment: '48',
  landmarkNote: null,
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Address;

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    status: 'SEARCHING',
    serviceId: SERVICE_ID,
    addressId: HOME.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: null,
    masterId: null,
    redispatchCount: 0,
    acceptedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let served: Order = order();
let requested: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    requested.push(`${request.method} ${url.pathname}`);

    const body =
      url.pathname === `/orders/${ORDER_ID}`
        ? served
        : url.pathname === '/addresses'
          ? [HOME]
          : url.pathname === `/services/${SERVICE_ID}`
            ? SERVICE
            : [];

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

interface Mounted {
  readonly store: AppStore;
  readonly sockets: FakeSocketFactory;
}

/**
 * Mounts the order screen under the app's real connection, with a fake
 * transport under it.
 *
 * The connection is the production one — only the socket is replaced — so
 * every assertion below runs through the same re-join, sequence-guard and
 * cache-patching code the app ships.
 */
async function mount({ withSocket = true } = {}): Promise<Mounted> {
  installTransport();
  const sockets = createFakeSocketFactory();
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        <OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />
      </RealtimeProvider>
    </Provider>,
  );

  await waitFor(() => {
    expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
  });

  if (withSocket) {
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });
  }

  return { store, sockets };
}

function transition(overrides: Partial<OrderTransitionRealtimeEvent> = {}) {
  return {
    orderId: ORDER_ID,
    status: 'ACCEPTED',
    masterId: 'master-1',
    priceMinor: 6700,
    at: 2_000,
    ...overrides,
  } satisfies OrderTransitionRealtimeEvent;
}

/**
 * What a customer sees when the server publishes something (issue #170).
 *
 * **Asserted on the screen, never on the cache.** The acceptance criterion is
 * "a status change published by the server updates the screen without a manual
 * refresh", and a test that read `store.getState()` would pass with a patch
 * nothing renders. The screen is the assertion (CLAUDE.md §13).
 */
describe('an order screen under a live connection', () => {
  beforeEach(() => {
    served = order();
    requested = [];
  });

  it('updates without a refresh when the server publishes a transition', async () => {
    const { sockets } = await mount();

    await actAndSettle(() => {
      sockets.latest().serverEmit(ORDER_TRANSITION_EVENT, transition());
    });

    await waitFor(() => {
      expect(screen.getByText(copy.status.ACCEPTED.label)).toBeOnTheScreen();
    });
  });

  it('joins the order’s room while the screen is on it', async () => {
    const { sockets } = await mount();

    expect(sockets.latest().emitted).toEqual([
      { event: 'room:join', payload: { kind: 'order', orderId: ORDER_ID } },
    ]);
  });

  /**
   * The regression the sequence guard exists for: a frame published before a
   * gap arriving after one published during it must not walk the screen
   * backwards.
   */
  it('does not move backwards when an older event arrives late', async () => {
    const { sockets } = await mount();

    await actAndSettle(() => {
      sockets.latest().serverEmit(ORDER_TRANSITION_EVENT, transition());
    });
    await waitFor(() => {
      expect(screen.getByText(copy.status.ACCEPTED.label)).toBeOnTheScreen();
    });

    await actAndSettle(() => {
      sockets
        .latest()
        .serverEmit(
          ORDER_TRANSITION_EVENT,
          transition({ status: 'SEARCHING', masterId: null, priceMinor: null, at: 1_000 }),
        );
    });

    expect(screen.getByText(copy.status.ACCEPTED.label)).toBeOnTheScreen();
    expect(screen.queryByText(copy.status.SEARCHING.label)).toBeNull();
  });

  /**
   * "A missed event must never leave the UI permanently wrong." The screen
   * cannot know what it missed, so it re-reads — and the server's answer is
   * what it ends up showing, not the last frame it happened to receive.
   */
  it('refetches over HTTP after a gap and shows what the server now says', async () => {
    const { sockets } = await mount();
    const before = requested.filter((line) => line === `GET /orders/${ORDER_ID}`).length;

    served = order({ status: 'MASTER_ON_THE_WAY', masterId: 'master-1', priceMinor: 6700 });

    await actAndSettle(() => {
      sockets.latest().serverDisconnect();
    });
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    await waitFor(() => {
      expect(screen.getByText(copy.status.MASTER_ON_THE_WAY.label)).toBeOnTheScreen();
    });
    expect(requested.filter((line) => line === `GET /orders/${ORDER_ID}`).length).toBeGreaterThan(
      before,
    );
  });

  /**
   * The socket is never the reason a screen works. A phone on a network that
   * blocks WebSocket, or an API with the gateway down, must be
   * indistinguishable from a phone that simply has not received anything yet.
   */
  it('renders the whole order with a connection that never comes up', async () => {
    const { sockets } = await mount({ withSocket: false });

    await actAndSettle(() => {
      sockets.latest().serverRefuse();
    });

    expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    expect(screen.getByText('Mətbəxdə kran sızır.')).toBeOnTheScreen();
    expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
  });
});
