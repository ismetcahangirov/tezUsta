import type {
  Address,
  MasterPositionRealtimeEvent,
  Order,
  OrderStatus,
  OrderTransitionRealtimeEvent,
  Service,
} from '@tezusta/types';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory, type FakeSocketFactory } from '../../test/support/fake-socket';
import { pointText, valueOf } from '../../test/support/fake-map-surface';
import { createTestStore } from '../../test/support/test-store';
import { OrderDetail } from '../orders/OrderDetail';
import { ORDERS_COPY as ordersCopy } from '../orders/orders-copy';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { MASTER_POSITION_EVENT, ORDER_TRANSITION_EVENT } from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { trackingApi } from '../realtime/tracking-endpoints';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';
import { TRACKING_COPY as copy } from './tracking-copy';
import { isTrackedStatus, POSITION_FRESHNESS_MS } from './tracking-policy';

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

const DESCRIPTION = 'Mətbəxdə kran sızır.';

function order(status: OrderStatus, masterId = 'master-1'): Order {
  const assigned = status !== 'SEARCHING';
  return {
    id: ORDER_ID,
    status,
    serviceId: SERVICE_ID,
    addressId: HOME.id,
    description: DESCRIPTION,
    priceMinor: assigned ? 6700 : null,
    masterId: assigned ? masterId : null,
    redispatchCount: 0,
    acceptedAt: assigned ? '2026-01-01T00:05:00.000Z' : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let served: Order = order('SEARCHING');
/** The store behind the screen the current test mounted. */
let store: AppStore;

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);

    const body =
      pathname === `/orders/${ORDER_ID}`
        ? served
        : pathname === '/addresses'
          ? [HOME]
          : pathname === `/services/${SERVICE_ID}`
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

/** The screen the customer is on, under the app's real connection and a fake socket. */
async function mount(status: OrderStatus): Promise<FakeSocketFactory> {
  served = order(status);
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
    expect(screen.getByText(ordersCopy.status[status].label)).toBeOnTheScreen();
  });
  // The address resolves from its own request; the map's destination is it.
  await waitFor(() => {
    expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
  });

  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  /**
   * A precondition, not an assertion: the tracking entry has to exist before
   * a point can land in it. A point published earlier is dropped — which is
   * the production behaviour for a screen not yet subscribed — so a test that
   * published into that window would be testing the race, not the screen.
   */
  if (isTrackedStatus(status)) {
    await waitFor(() => {
      expect(
        trackingApi.endpoints.masterPosition.select(ORDER_ID)(store.getState()).isSuccess,
      ).toBe(true);
    });
  }

  return sockets;
}

/** Comfortably more than one frame at 60 Hz. */
const ANIMATION_FRAME_MS = 20;

let nextAt = 10_000;

function report(latitude: number, longitude: number): MasterPositionRealtimeEvent {
  nextAt += 1_000;
  return { orderId: ORDER_ID, latitude, longitude, at: nextAt };
}

function transition(status: OrderStatus): OrderTransitionRealtimeEvent {
  nextAt += 1_000;
  return { orderId: ORDER_ID, status, masterId: 'master-1', priceMinor: 6700, at: nextAt };
}

/**
 * Delivers one frame. **It does not wait for the screen**: RTK's
 * `autoBatchEnhancer` defers the store notification for RTK Query's own
 * actions to the next animation frame, which on a slow CI runner lands after
 * `actAndSettle`'s microtask. A positive assertion on what a frame draws goes
 * through `waitFor` (#209); a synchronous `getBy*` straight after a publish
 * passes locally and fails on a loaded machine.
 */
async function publish(sockets: FakeSocketFactory, event: string, payload: unknown) {
  await actAndSettle(() => {
    sockets.latest().serverEmit(event, payload);
  });
}

/** Whether the store still holds any position for this order at all. */
function positionHeld(): boolean {
  const entry = trackingApi.endpoints.masterPosition.select(ORDER_ID)(store.getState());
  return entry.data !== undefined && entry.data !== null;
}

function masterDrawnAt(): string | undefined {
  return valueOf(screen.getByLabelText(copy.masterMarker));
}

/**
 * The customer watching the master approach, end to end (issue #172).
 *
 * The connection, the sequence guard and the cache are the production ones;
 * only the socket and the map are stand-ins. Every assertion is on the screen.
 */
describe('tracking the master on the order screen', () => {
  beforeEach(() => {
    nextAt = 10_000;
  });

  describe('per status', () => {
    it('shows no map before a master has accepted', async () => {
      const sockets = await mount('SEARCHING');

      // Even a stray point is not drawn for an order nobody has accepted.
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));

      expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
    });

    it('says there is no position yet once accepted, and the order still reads in full', async () => {
      await mount('ACCEPTED');

      expect(screen.getByText(copy.absentTitle)).toBeOnTheScreen();
      expect(screen.getByText(DESCRIPTION)).toBeOnTheScreen();
      expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
    });

    it('draws the master travelling, and moves the marker as reports arrive', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');

      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));

      await waitFor(() => {
        expect(screen.getByText(copy.live)).toBeOnTheScreen();
      });
      expect(masterDrawnAt()).toBe(pointText({ latitude: 40.4, longitude: 49.8 }));
      expect(valueOf(screen.getByLabelText(copy.destinationMarker))).toBe(pointText(HOME));

      await publish(sockets, MASTER_POSITION_EVENT, report(40.39, 49.85));

      await waitFor(() => {
        expect(masterDrawnAt()).not.toBe(pointText({ latitude: 40.4, longitude: 49.8 }));
      });
    });

    it('takes the map away when the master arrives', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));

      await publish(sockets, ORDER_TRANSITION_EVENT, transition('MASTER_ARRIVED'));

      await waitFor(() => {
        expect(screen.getByText(ordersCopy.status.MASTER_ARRIVED.label)).toBeOnTheScreen();
      });
      expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
      expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
    });

    it('shows no position after the order ends, even when a late point arrives', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));

      await publish(sockets, ORDER_TRANSITION_EVENT, transition('CANCELLED'));
      await waitFor(() => {
        expect(screen.getByText(ordersCopy.status.CANCELLED.label)).toBeOnTheScreen();
      });
      await publish(sockets, MASTER_POSITION_EVENT, report(40.41, 49.81));

      expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.masterMarker)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.masterMarkerStale)).not.toBeOnTheScreen();
    });
  });

  /**
   * The position is PII, and "hidden" is not enough: once the order leaves the
   * tracked statuses the point must no longer be held on the phone at all
   * (CLAUDE.md §11). Asserted on the store because what is not rendered is
   * not visible on screen either way.
   */
  describe('what the phone keeps', () => {
    it.each(['MASTER_ARRIVED', 'CANCELLED'] as const)(
      'drops the master’s position from the store at %s',
      async (next) => {
        const sockets = await mount('MASTER_ON_THE_WAY');
        await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
        expect(positionHeld()).toBe(true);

        await publish(sockets, ORDER_TRANSITION_EVENT, transition(next));

        await waitFor(() => {
          expect(screen.getByText(ordersCopy.status[next].label)).toBeOnTheScreen();
        });
        await waitFor(() => {
          expect(positionHeld()).toBe(false);
        });
      },
    );
  });

  describe('freshness', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    /**
     * Moves the fake clock, and lets React run whatever that released.
     *
     * Also needed after every frame: RTK's default `autoBatchEnhancer` defers
     * store notifications for RTK Query's own actions to the next animation
     * frame, and under fake timers that frame arrives only when the clock is
     * moved.
     */
    async function elapse(ms: number): Promise<void> {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
      });
    }

    it('labels a point stale once the freshness window has passed, without a new frame', async () => {
      // Fake time that still advances on its own, so the requests the screen
      // makes while mounting resolve exactly as they do with real timers.
      jest.useFakeTimers({ advanceTimers: true });
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
      await elapse(ANIMATION_FRAME_MS);
      expect(screen.getByText(copy.live)).toBeOnTheScreen();

      await elapse(POSITION_FRESHNESS_MS + 1_000);

      expect(screen.getByText(copy.stale)).toBeOnTheScreen();
      expect(screen.queryByText(copy.live)).not.toBeOnTheScreen();
      expect(screen.getByLabelText(copy.masterMarkerStale)).toBeOnTheScreen();
    });

    it('goes back to live when a fresh point follows a stale one', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
      await elapse(ANIMATION_FRAME_MS);
      await elapse(POSITION_FRESHNESS_MS + 1_000);
      expect(screen.getByText(copy.stale)).toBeOnTheScreen();

      await publish(sockets, MASTER_POSITION_EVENT, report(40.39, 49.85));
      await elapse(ANIMATION_FRAME_MS);

      expect(screen.getByText(copy.live)).toBeOnTheScreen();
      // Placed on the new point, not glided to it from the stale one.
      expect(masterDrawnAt()).toBe(pointText({ latitude: 40.39, longitude: 49.85 }));
    });
  });

  describe('reconnection', () => {
    it('says it is reconnecting while the socket is down, never live', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));

      await actAndSettle(() => {
        sockets.latest().serverDisconnect();
      });

      await waitFor(() => {
        expect(screen.getByText(copy.reconnecting)).toBeOnTheScreen();
      });
      expect(screen.queryByText(copy.live)).not.toBeOnTheScreen();
      expect(screen.getByLabelText(copy.masterMarkerStale)).toBeOnTheScreen();
    });

    it('resolves to what the server says after the refetch, not to the last frame', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
      await actAndSettle(() => {
        sockets.latest().serverDisconnect();
      });

      // The master arrived during the gap; the frame saying so was missed.
      served = order('MASTER_ARRIVED');
      await actAndSettle(() => {
        sockets.latest().serverConnect();
      });

      await waitFor(() => {
        expect(screen.getByText(ordersCopy.status.MASTER_ARRIVED.label)).toBeOnTheScreen();
      });
      expect(screen.queryByText(copy.reconnecting)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
    });

    /**
     * The re-dispatch the socket never told us about: master A was on the way,
     * the order went back to SEARCHING and master B accepted, all during the
     * gap. The refetch goes straight from A on the way to B accepted, the
     * status stays tracked — and A's last point must not be drawn as B's.
     */
    it('never shows the previous master’s point after a re-dispatch during a gap', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
      await waitFor(() => {
        expect(screen.getByLabelText(copy.masterMarker)).toBeOnTheScreen();
      });
      await actAndSettle(() => {
        sockets.latest().serverDisconnect();
      });

      served = order('ACCEPTED', 'master-2');
      await actAndSettle(() => {
        sockets.latest().serverConnect();
      });

      await waitFor(() => {
        expect(screen.getByText(ordersCopy.status.ACCEPTED.label)).toBeOnTheScreen();
      });
      expect(screen.getByText(copy.absentTitle)).toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.masterMarker)).not.toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.masterMarkerStale)).not.toBeOnTheScreen();

      // The new master's first report is theirs, and is drawn.
      await publish(sockets, MASTER_POSITION_EVENT, report(40.3, 49.9));
      await waitFor(() => {
        expect(masterDrawnAt()).toBe(pointText({ latitude: 40.3, longitude: 49.9 }));
      });
    });

    it('is live again once a point arrives over the restored connection', async () => {
      const sockets = await mount('MASTER_ON_THE_WAY');
      await publish(sockets, MASTER_POSITION_EVENT, report(40.4, 49.8));
      await actAndSettle(() => {
        sockets.latest().serverDisconnect();
      });
      await actAndSettle(() => {
        sockets.latest().serverConnect();
      });

      await publish(sockets, MASTER_POSITION_EVENT, report(40.39, 49.85));

      await waitFor(() => {
        expect(screen.getByText(copy.live)).toBeOnTheScreen();
      });
      expect(screen.queryByText(copy.reconnecting)).not.toBeOnTheScreen();
      // The first point after the gap is placed, not animated from before it.
      expect(masterDrawnAt()).toBe(pointText({ latitude: 40.39, longitude: 49.85 }));
    });
  });
});
