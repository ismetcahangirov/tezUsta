import type { CurrentMasterJob, MasterJob, OrderTransitionRealtimeEvent } from '@tezusta/types';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { ORDER_TRANSITION_EVENT } from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { signedIn } from '../store/session-slice';
import { JobDetail } from './JobDetail';
import { MASTER_JOBS_COPY as copy } from './master-jobs-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const JOB: MasterJob = {
  orderId: 'order-1',
  offerId: 'offer-1',
  customerRating: { ratingAverage: null, ratingCount: 0 },
  status: 'MASTER_ON_THE_WAY',
  serviceId: 'service-1',
  description: 'Kran sızır.',
  priceMinor: 6700,
  acceptedAt: '2026-01-01T00:00:00.000Z',
  address: {
    id: 'address-1',
    label: null,
    formattedAddress: 'Nizami küçəsi 203',
    latitude: 40.37,
    longitude: 49.84,
    building: null,
    entrance: null,
    floor: null,
    apartment: null,
    landmarkNote: null,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

let served: CurrentMasterJob = { job: JOB };

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const path = new URL(request.url).pathname;
    const body =
      path === '/masters/me/jobs/current' ? served : { id: 'service-1', name: 'Santexnik' };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(): Promise<FakeSocketFactory> {
  installTransport();
  const sockets = createFakeSocketFactory();
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['master'] }));

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        <JobDetail onBack={jest.fn()} />
      </RealtimeProvider>
    </Provider>,
  );

  expect(await screen.findByText(copy.job.status.MASTER_ON_THE_WAY)).toBeOnTheScreen();

  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  return sockets;
}

/**
 * The job screen under a live connection (issues #199, #171).
 *
 * The case that matters is the second one. The socket is closed whenever the
 * app is backgrounded — which is when a master is driving — so a customer's
 * cancellation is usually a frame this phone never received. What must still
 * happen is that the next time the connection comes back, the job is re-read
 * and leaves the screen, taking the customer's address with it; and, through
 * `MasterWorkProvider`, that the background session ends.
 */
describe('the master’s job under a live connection', () => {
  beforeEach(() => {
    served = { job: JOB };
  });

  it('leaves the screen when the customer cancels while the master is watching', async () => {
    const sockets = await mount();

    served = { job: null };
    await actAndSettle(() => {
      sockets.latest().serverEmit(ORDER_TRANSITION_EVENT, {
        orderId: JOB.orderId,
        status: 'CANCELLED',
        masterId: null,
        priceMinor: null,
        at: 5_000,
      } satisfies OrderTransitionRealtimeEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(copy.job.goneTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByText(JOB.address.formattedAddress)).not.toBeOnTheScreen();
  });

  it('re-reads the job after a gap in which the cancellation was missed', async () => {
    const sockets = await mount();

    await actAndSettle(() => {
      sockets.latest().serverDisconnect();
    });
    // The customer cancels while this phone has no socket: no frame arrives.
    served = { job: null };
    await actAndSettle(() => {
      sockets.latest().serverConnect();
    });

    await waitFor(() => {
      expect(screen.getByText(copy.job.goneTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByText(JOB.address.formattedAddress)).not.toBeOnTheScreen();
  });
});
