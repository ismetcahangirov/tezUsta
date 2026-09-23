import type { CurrentMasterJob, MasterAvailability, MasterJob } from '@tezusta/types';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { api } from '../api/api-slice';
import { LOCATION_BUDGET } from '../location/location-budget';
import type { LocationPermission } from '../location/location-permission';
import type { LocationPort, WatchOptions } from '../location/location-port';
import { useMasterWork } from './master-work-context';
import { MasterWorkProvider } from './MasterWorkProvider';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ONLINE: MasterAvailability = {
  isAvailable: true,
  isLive: true,
  expiresInSeconds: 170,
  heartbeatSeconds: 3600,
};

function job(status: MasterJob['status']): MasterJob {
  return {
    orderId: 'order-1',
    offerId: 'offer-1',
    status,
    serviceId: 'service-1',
    description: 'Kran sızır.',
    priceMinor: 6700,
    acceptedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

interface FakePlatform {
  readonly port: LocationPort;
  /** Every subscription the reporter opened, in order. */
  readonly watches: WatchOptions[];
  /** How many subscriptions are open now. */
  open(): number;
  backgroundRequests(): number;
}

/**
 * A platform that grants foreground access and answers background access with
 * `background` — before asking, and after.
 */
function platform(background: {
  before: LocationPermission;
  after?: LocationPermission;
}): FakePlatform {
  const watches: WatchOptions[] = [];
  let open = 0;
  let requests = 0;

  return {
    watches,
    open: () => open,
    backgroundRequests: () => requests,
    port: {
      permission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
      backgroundPermission: () => Promise.resolve(background.before),
      requestBackgroundPermission: () => {
        requests += 1;
        return Promise.resolve(background.after ?? background.before);
      },
      lastKnown: () => Promise.resolve({ latitude: 40.37, longitude: 49.84 }),
      current: () => Promise.resolve({ latitude: 40.37, longitude: 49.84 }),
      watch: (options) => {
        watches.push(options);
        open += 1;
        return Promise.resolve({
          remove: () => {
            open -= 1;
          },
        });
      },
    },
  };
}

let jobReply: CurrentMasterJob = { job: null };
let availabilityReply: MasterAvailability = ONLINE;

function installTransport(): void {
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const path = new URL(request.url).pathname;
    const body =
      path === '/masters/me/jobs/current'
        ? jobReply
        : path === '/masters/me/availability'
          ? availabilityReply
          : path === '/masters/me/location'
            ? { recordedAt: new Date().toISOString(), presence: availabilityReply }
            : { id: 'master-1' };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

function Probe(): React.JSX.Element {
  const { reporter, backgroundDenied } = useMasterWork();
  return (
    <Text>
      {reporter.state}
      {backgroundDenied ? ' background-denied' : ''}
    </Text>
  );
}

async function mount(fake: FakePlatform): Promise<ReturnType<typeof createTestStore>> {
  installTransport();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <MasterWorkProvider port={fake.port}>
        <Probe />
      </MasterWorkProvider>
    </Provider>,
  );
  return store;
}

function last(fake: FakePlatform): WatchOptions | undefined {
  return fake.watches.at(-1);
}

beforeEach(() => {
  jobReply = { job: null };
  availabilityReply = ONLINE;
});

describe('MasterWorkProvider drives the reporter from the server (issue #171)', () => {
  it('reports at the idle floor for an online master with no job, in the foreground only', async () => {
    const fake = platform({ before: 'askable' });
    await mount(fake);

    await waitFor(() => {
      expect(screen.getByText('online')).toBeOnTheScreen();
    });
    expect(last(fake)).toEqual({
      distanceMeters: LOCATION_BUDGET.online?.distanceMeters,
      needsFreshFix: false,
      background: false,
    });
    expect(fake.backgroundRequests()).toBe(0);
  });

  it('asks for background access at accept, and travels in a background session once granted', async () => {
    jobReply = { job: job('ACCEPTED') };
    const fake = platform({ before: 'askable', after: 'granted' });
    await mount(fake);

    await waitFor(() => {
      expect(last(fake)?.background).toBe(true);
    });
    expect(fake.backgroundRequests()).toBe(1);
    expect(last(fake)).toEqual({
      distanceMeters: LOCATION_BUDGET.travelling?.distanceMeters,
      needsFreshFix: true,
      background: true,
    });
    expect(fake.open()).toBe(1);
  });

  it('drops to the working floor once the master has arrived', async () => {
    jobReply = { job: job('MASTER_ARRIVED') };
    const fake = platform({ before: 'granted' });
    await mount(fake);

    await waitFor(() => {
      expect(screen.getByText('working')).toBeOnTheScreen();
    });
    await waitFor(() => {
      expect(last(fake)).toEqual({
        distanceMeters: null,
        needsFreshFix: false,
        background: true,
      });
    });
    // Already granted: nothing to ask.
    expect(fake.backgroundRequests()).toBe(0);
  });

  /**
   * Completion, a customer cancellation and a re-dispatch all reach the app
   * the same way — the job read answers `null` after the invalidation the
   * master's own mutation or the socket's `order:transition` raises — so one
   * test covers every terminal way out. That the read answers `null` in each
   * case is the server's contract, asserted in `master-current-job.e2e.test.ts`.
   */
  it('ends the background session when the job ends, whichever way it ends', async () => {
    jobReply = { job: job('MASTER_ON_THE_WAY') };
    const fake = platform({ before: 'granted' });
    const store = await mount(fake);
    await waitFor(() => {
      expect(last(fake)?.background).toBe(true);
    });

    jobReply = { job: null };
    store.dispatch(api.util.invalidateTags(['MasterJob']));

    await waitFor(() => {
      expect(screen.getByText('online')).toBeOnTheScreen();
    });
    expect(last(fake)?.background).toBe(false);
    expect(fake.open()).toBe(1);
  });

  it('keeps the job working in the foreground when background access is refused, and says so', async () => {
    jobReply = { job: job('ACCEPTED') };
    const fake = platform({ before: 'askable', after: 'blocked' });
    await mount(fake);

    expect(await screen.findByText('travelling background-denied')).toBeOnTheScreen();
    expect(last(fake)?.background).toBe(false);
    expect(fake.open()).toBe(1);
  });

  it('reports nothing for a master who is offline, even with a job', async () => {
    availabilityReply = { ...ONLINE, isAvailable: false, isLive: false };
    jobReply = { job: job('MASTER_ON_THE_WAY') };
    const fake = platform({ before: 'granted' });
    await mount(fake);

    await waitFor(() => {
      expect(screen.getByText('offline')).toBeOnTheScreen();
    });
    expect(fake.open()).toBe(0);
  });
});
