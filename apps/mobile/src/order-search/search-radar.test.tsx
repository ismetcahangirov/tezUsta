import type {
  Address,
  Order,
  OrderSearchProgress,
  OrderSearchWaveRealtimeEvent,
  OrderStatus,
  OrderTransitionRealtimeEvent,
  Service,
} from '@tezusta/types';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory, type FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { OrderDetail } from '../orders/OrderDetail';
import { ORDERS_COPY as ordersCopy } from '../orders/orders-copy';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { ORDER_SEARCH_WAVE_EVENT, ORDER_TRANSITION_EVENT } from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';
import { TRACKING_COPY as trackingCopy } from '../tracking/tracking-copy';
import { orderSearchApi } from './order-search-endpoints';
import { SEARCH_RADAR_COPY as copy } from './search-radar-copy';

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

function order(status: OrderStatus): Order {
  const assigned = status !== 'SEARCHING' && status !== 'NO_MASTER_FOUND';
  return {
    id: ORDER_ID,
    status,
    serviceId: SERVICE_ID,
    addressId: HOME.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: assigned ? 6700 : null,
    pricingKind: 'fixed',
    priceApprovedAt: null,
    masterId: assigned ? 'master-1' : null,
    redispatchCount: 0,
    acceptedAt: assigned ? '2026-01-01T00:05:00.000Z' : null,
    arrivalPromise: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function search(offeredCount: number, radiusM = 3_000): OrderSearchProgress {
  return {
    round: 1,
    radiusM,
    maxRadiusM: 10_000,
    endsAt: '2026-01-01T00:03:00.000Z',
    offeredCount,
    cells: [{ latitude: 40.3775, longitude: 49.8917 }],
  };
}

let servedOrder: Order = order('SEARCHING');
let servedSearch: { status: number; body: unknown } = { status: 200, body: search(1) };
let searchReads = 0;
let store: AppStore;

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);

    let reply: { status: number; body: unknown } = { status: 200, body: [] };
    if (pathname === `/orders/${ORDER_ID}`) {
      reply = { status: 200, body: servedOrder };
    } else if (pathname === `/orders/${ORDER_ID}/search`) {
      searchReads += 1;
      reply = servedSearch;
    } else if (pathname === '/addresses') {
      reply = { status: 200, body: [HOME] };
    } else if (pathname === `/services/${SERVICE_ID}`) {
      reply = { status: 200, body: SERVICE };
    }

    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(): Promise<FakeSocketFactory> {
  installTransport();
  const sockets = createFakeSocketFactory();
  store = createTestStore();
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
    expect(screen.getByText(ordersCopy.status[servedOrder.status].label)).toBeOnTheScreen();
  });
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });
  return sockets;
}

let nextAt = 10_000;

/** Delivers one frame; positive assertions after it go through `waitFor` (#209). */
async function publish(sockets: FakeSocketFactory, event: string, payload: unknown) {
  await actAndSettle(() => {
    sockets.latest().serverEmit(event, payload);
  });
}

function wave(offeredCount: number): OrderSearchWaveRealtimeEvent {
  nextAt += 1_000;
  return { orderId: ORDER_ID, round: 2, radiusM: 4_400, offeredCount, at: nextAt };
}

function transition(status: OrderStatus): OrderTransitionRealtimeEvent {
  nextAt += 1_000;
  const assigned = status === 'ACCEPTED';
  return {
    orderId: ORDER_ID,
    status,
    masterId: assigned ? 'master-1' : null,
    priceMinor: assigned ? 6700 : null,
    at: nextAt,
  };
}

function searchEntryHeld(): boolean {
  return orderSearchApi.endpoints.orderSearch.select(ORDER_ID)(store.getState()).data !== undefined;
}

/**
 * The radar on the real order screen, through the real connection, sequence
 * guard and cache (issue #398). The socket is the fake; the screen, the store
 * and the policy are the app's.
 */
describe('the search radar on the order screen', () => {
  beforeEach(() => {
    servedOrder = order('SEARCHING');
    servedSearch = { status: 200, body: search(1) };
    searchReads = 0;
  });

  it('re-reads on every wave frame and shows the new count', async () => {
    const sockets = await mount();
    expect(await screen.findByText(copy.reached(1))).toBeOnTheScreen();
    const readsBefore = searchReads;

    servedSearch = { status: 200, body: search(4, 4_400) };
    await publish(sockets, ORDER_SEARCH_WAVE_EVENT, wave(4));

    expect(await screen.findByText(copy.reached(4))).toBeOnTheScreen();
    expect(searchReads).toBe(readsBefore + 1);
  });

  it('gives way to the tracking card when a master accepts, without a reload', async () => {
    const sockets = await mount();
    expect(await screen.findByText(copy.title)).toBeOnTheScreen();

    servedOrder = order('ACCEPTED');
    await publish(sockets, ORDER_TRANSITION_EVENT, transition('ACCEPTED'));

    await waitFor(() => {
      expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
    });
    expect(screen.getByText(trackingCopy.title)).toBeOnTheScreen();
  });

  it.each(['NO_MASTER_FOUND', 'CANCELLED'] as const)(
    'disappears on %s, and the store no longer holds the cells',
    async (status) => {
      const sockets = await mount();
      expect(await screen.findByText(copy.reached(1))).toBeOnTheScreen();
      expect(searchEntryHeld()).toBe(true);

      servedOrder = order(status);
      await publish(sockets, ORDER_TRANSITION_EVENT, transition(status));

      await waitFor(() => {
        expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
      });
      await waitFor(() => {
        expect(searchEntryHeld()).toBe(false);
      });
    },
  );

  it('shows no error when the server answers that the order stopped searching (409)', async () => {
    servedSearch = { status: 409, body: { error: { code: 'ORDER_NOT_SEARCHING' } } };
    await mount();

    await waitFor(() => {
      expect(searchReads).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.error)).not.toBeOnTheScreen();
  });
});
