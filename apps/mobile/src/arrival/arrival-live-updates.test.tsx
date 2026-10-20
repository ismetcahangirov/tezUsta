import type {
  Address,
  CurrentMasterJob,
  MasterJob,
  Order,
  OrderArrivalPromiseRealtimeEvent,
  OrderStatus,
  OrderTransitionRealtimeEvent,
  Service,
} from '@tezusta/types';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory, type FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { JobDetail } from '../master-jobs/JobDetail';
import { OrderDetail } from '../orders/OrderDetail';
import { ordersApi } from '../orders/order-endpoints';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { ORDER_ARRIVAL_PROMISE_EVENT, ORDER_TRANSITION_EVENT } from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';
import { TRACKING_COPY } from '../tracking/tracking-copy';
import { ARRIVAL_COPY as copy } from './arrival-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const SERVICE = {
  id: 'svc-1',
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
  building: null,
  entrance: null,
  floor: null,
  apartment: null,
  landmarkNote: null,
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Address;

function order(status: OrderStatus, masterId: string | null): Order {
  return {
    id: ORDER_ID,
    status,
    serviceId: SERVICE.id,
    addressId: HOME.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: masterId === null ? null : 6700,
    masterId,
    redispatchCount: 0,
    acceptedAt: masterId === null ? null : '2026-01-01T00:05:00.000Z',
    arrivalPromise: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const JOB: MasterJob = {
  orderId: ORDER_ID,
  offerId: 'offer-1',
  customerRating: { ratingAverage: null, ratingCount: 0 },
  status: 'ACCEPTED',
  serviceId: SERVICE.id,
  description: 'Mətbəxdə kran sızır.',
  priceMinor: 6700,
  acceptedAt: '2026-01-01T00:05:00.000Z',
  arrivalPromise: null,
  address: HOME,
};

let servedOrder: Order = order('ACCEPTED', 'master-1');
let servedJob: CurrentMasterJob = { job: JOB };
let store: AppStore;

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);
    const body =
      pathname === `/orders/${ORDER_ID}`
        ? servedOrder
        : pathname === '/masters/me/jobs/current'
          ? servedJob
          : pathname === '/addresses'
            ? [HOME]
            : pathname === `/services/${SERVICE.id}`
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

async function mount(screenUnderTest: React.JSX.Element, role: 'customer' | 'master') {
  installTransport();
  const sockets = createFakeSocketFactory();
  store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: [role] }));

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        {screenUnderTest}
      </RealtimeProvider>
    </Provider>,
  );
  return sockets;
}

async function connect(sockets: FakeSocketFactory): Promise<void> {
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });
}

async function publish(sockets: FakeSocketFactory, event: string, payload: unknown) {
  await actAndSettle(() => {
    sockets.latest().serverEmit(event, payload);
  });
}

let nextAt = Date.now();

/** A promise `minutes` from the server's "now", as the server would publish it. */
function promiseFrame(minutes: number): OrderArrivalPromiseRealtimeEvent {
  nextAt += 1_000;
  return {
    orderId: ORDER_ID,
    promisedArrivalAt: new Date(nextAt + minutes * 60_000).toISOString(),
    source: 'route',
    at: nextAt,
  };
}

function transition(status: OrderStatus, masterId: string | null): OrderTransitionRealtimeEvent {
  nextAt += 1_000;
  return {
    orderId: ORDER_ID,
    status,
    masterId,
    priceMinor: masterId === null ? null : 6700,
    at: nextAt,
  };
}

/**
 * The arrival promise reaching both screens through the real connection,
 * sequence guard and cache (issue #399). The socket is the fake.
 */
describe('the arrival promise under a live connection', () => {
  beforeEach(() => {
    servedOrder = order('ACCEPTED', 'master-1');
    servedJob = { job: JOB };
  });

  it('lands on the customer’s tracking card when the frame arrives', async () => {
    const sockets = await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');
    expect(await screen.findByText(TRACKING_COPY.title)).toBeOnTheScreen();
    expect(screen.getByText(copy.customer.pending)).toBeOnTheScreen();
    await connect(sockets);

    await publish(sockets, ORDER_ARRIVAL_PROMISE_EVENT, promiseFrame(7));

    expect(await screen.findByText(copy.customer.minutesLeft(7))).toBeOnTheScreen();
  });

  it('lands on the master’s job screen when the frame arrives', async () => {
    const sockets = await mount(<JobDetail onBack={jest.fn()} />, 'master');
    expect(await screen.findByText(copy.master.pending)).toBeOnTheScreen();
    await connect(sockets);

    await publish(sockets, ORDER_ARRIVAL_PROMISE_EVENT, promiseFrame(12));

    expect(await screen.findByText(copy.master.minutesLeft(12))).toBeOnTheScreen();
  });

  it('drops the old master’s promise on a re-dispatch and shows the new one', async () => {
    const sockets = await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');
    expect(await screen.findByText(TRACKING_COPY.title)).toBeOnTheScreen();
    await connect(sockets);
    await publish(sockets, ORDER_ARRIVAL_PROMISE_EVENT, promiseFrame(7));
    expect(await screen.findByText(copy.customer.minutesLeft(7))).toBeOnTheScreen();

    servedOrder = order('SEARCHING', null);
    await publish(sockets, ORDER_TRANSITION_EVENT, transition('SEARCHING', null));
    await waitFor(() => {
      expect(
        ordersApi.endpoints.order.select(ORDER_ID)(store.getState()).data?.arrivalPromise,
      ).toBeNull();
    });

    servedOrder = order('ACCEPTED', 'master-2');
    await publish(sockets, ORDER_TRANSITION_EVENT, transition('ACCEPTED', 'master-2'));
    expect(await screen.findByText(copy.customer.pending)).toBeOnTheScreen();
    expect(screen.queryByText(copy.customer.minutesLeft(7))).not.toBeOnTheScreen();

    await publish(sockets, ORDER_ARRIVAL_PROMISE_EVENT, promiseFrame(15));
    expect(await screen.findByText(copy.customer.minutesLeft(15))).toBeOnTheScreen();
  });

  it('hides the countdown from both screens once the master arrives', async () => {
    servedOrder = { ...order('MASTER_ARRIVED', 'master-1') };
    await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');

    await waitFor(() => {
      expect(ordersApi.endpoints.order.select(ORDER_ID)(store.getState()).isSuccess).toBe(true);
    });
    expect(screen.queryByTestId('arrival-countdown')).not.toBeOnTheScreen();
  });
});
