import type {
  AcceptedOffer,
  CurrentMasterJob,
  MasterAvailability,
  MasterJob,
  MasterOffer,
} from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { JobDetail, directionsUrl } from './JobDetail';
import { MASTER_JOBS_COPY as copy } from './master-jobs-copy';
import { MasterWork } from './MasterWork';

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

const OFFLINE: MasterAvailability = { ...ONLINE, isAvailable: false, isLive: false };

const SERVICE = { id: 'service-1', name: 'Santexnik', categoryId: 'c', pricing: null };

function offer(overrides: Partial<MasterOffer> = {}): MasterOffer {
  return {
    id: 'offer-1',
    serviceId: SERVICE.id,
    description: 'Mətbəxdə kran sızır.',
    photos: [],
    distanceBand: 'from_1_to_2km',
    priceMinor: 6700,
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    ...overrides,
  };
}

function job(overrides: Partial<MasterJob> = {}): MasterJob {
  return {
    orderId: 'order-1',
    offerId: 'offer-1',
    status: 'ACCEPTED',
    serviceId: SERVICE.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: 6700,
    acceptedAt: new Date().toISOString(),
    address: {
      id: 'address-1',
      label: null,
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.372613,
      longitude: 49.842717,
      building: null,
      entrance: null,
      floor: null,
      apartment: null,
      landmarkNote: null,
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
}

/**
 * Keyed by `METHOD path`. A value may be a list, answered in order and then
 * repeating its last entry — which is how a test says "the job is ACCEPTED
 * until the master taps, and MASTER_ON_THE_WAY after".
 */
let replies: Record<string, Reply | Reply[]> = {};
let sent: { method: string; path: string; body: unknown }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const text = typeof init?.body === 'string' ? init.body : await request.clone().text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    });

    const configured = replies[key];
    let reply: Reply;
    if (Array.isArray(configured)) {
      reply = configured.length > 1 ? (configured.shift() as Reply) : (configured[0] ?? {});
    } else {
      reply = configured ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '' } } };
    }

    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function current(value: MasterJob | null): Reply {
  const body: CurrentMasterJob = { job: value };
  return { body };
}

function posts(path: string): unknown[] {
  return sent.filter((call) => call.method === 'POST' && call.path === path).map((c) => c.body);
}

beforeEach(() => {
  replies = {
    [`GET /services/${SERVICE.id}`]: { body: SERVICE },
    'GET /masters/me/availability': { body: ONLINE },
  };
  sent = [];
});

describe('MasterWork on the master home', () => {
  async function mount(onOpenJob = jest.fn()): Promise<jest.Mock> {
    installTransport();
    await render(
      <Provider store={createTestStore()}>
        <MasterWork onOpenJob={onOpenJob} />
      </Provider>,
    );
    return onOpenJob;
  }

  it('shows the offers dispatch sent an online master with no job', async () => {
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = { body: [offer()] };
    await mount();

    expect(await screen.findByText('Mətbəxdə kran sızır.')).toBeOnTheScreen();
    expect(screen.getByText(copy.feed.distance.from_1_to_2km)).toBeOnTheScreen();
    expect(screen.getByText('67,00 ₼')).toBeOnTheScreen();
  });

  it('says so when there are no offers', async () => {
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = { body: [] };
    await mount();

    expect(await screen.findByText(copy.feed.emptyTitle)).toBeOnTheScreen();
  });

  it('leaves out an offer whose window has already run out', async () => {
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = {
      body: [offer({ expiresAt: new Date(Date.now() - 1_000).toISOString() })],
    };
    await mount();

    expect(await screen.findByText(copy.feed.emptyTitle)).toBeOnTheScreen();
  });

  it('shows no feed to a master who is offline', async () => {
    replies['GET /masters/me/availability'] = { body: OFFLINE };
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = { body: [offer()] };
    await mount();

    await waitFor(() => {
      expect(sent.some((call) => call.path === '/masters/me/jobs/current')).toBe(true);
    });
    expect(screen.queryByText(copy.feed.title)).not.toBeOnTheScreen();
    expect(sent.some((call) => call.path === '/masters/me/offers')).toBe(false);
  });

  it('shows the job instead of the feed while the master is on one', async () => {
    replies['GET /masters/me/jobs/current'] = current(job({ status: 'MASTER_ON_THE_WAY' }));
    replies['GET /masters/me/offers'] = { body: [offer()] };
    const onOpenJob = await mount();

    expect(await screen.findByText('Nizami küçəsi 203')).toBeOnTheScreen();
    expect(screen.getByText(copy.job.status.MASTER_ON_THE_WAY)).toBeOnTheScreen();
    expect(screen.queryByText(copy.feed.accept)).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByText('Nizami küçəsi 203'));
    expect(onOpenJob).toHaveBeenCalledTimes(1);
  });

  it('opens the job once an accept is won', async () => {
    const accepted: AcceptedOffer = {
      offerId: 'offer-1',
      orderId: 'order-1',
      serviceId: SERVICE.id,
      description: 'Mətbəxdə kran sızır.',
      priceMinor: 6700,
      acceptedAt: new Date().toISOString(),
      address: job().address,
    };
    replies['GET /masters/me/jobs/current'] = [current(null), current(job())];
    replies['GET /masters/me/offers'] = [{ body: [offer()] }, { body: [] }];
    replies['POST /masters/me/offers/offer-1/accept'] = { body: accepted };
    const onOpenJob = await mount();

    await fireEvent.press(await screen.findByText(copy.feed.accept));

    await waitFor(() => {
      expect(onOpenJob).toHaveBeenCalledTimes(1);
    });
    expect(posts('/masters/me/offers/offer-1/accept')).toHaveLength(1);
  });

  it.each([
    ['ORDER_ALREADY_TAKEN', copy.feed.taken],
    ['OFFER_NO_LONGER_ACTIONABLE', copy.feed.expired],
    ['MASTER_HAS_ACTIVE_ORDER', copy.feed.alreadyWorking],
    ['MASTER_NOT_ELIGIBLE_FOR_OFFER', copy.feed.notEligible],
  ])('explains a %s refusal and re-reads the feed', async (code, message) => {
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = [{ body: [offer()] }, { body: [] }];
    replies['POST /masters/me/offers/offer-1/accept'] = {
      status: 409,
      body: { error: { code, message: 'no' } },
    };
    const onOpenJob = await mount();

    await fireEvent.press(await screen.findByText(copy.feed.accept));

    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(onOpenJob).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(copy.feed.emptyTitle)).toBeOnTheScreen();
    });
  });

  it('declines an offer and drops it from the feed', async () => {
    replies['GET /masters/me/jobs/current'] = current(null);
    replies['GET /masters/me/offers'] = [{ body: [offer()] }, { body: [] }];
    replies['POST /masters/me/offers/offer-1/decline'] = {
      body: { offerId: 'offer-1', status: 'declined' },
    };
    await mount();

    await fireEvent.press(await screen.findByText(copy.feed.decline));

    expect(await screen.findByText(copy.feed.emptyTitle)).toBeOnTheScreen();
    expect(posts('/masters/me/offers/offer-1/decline')).toHaveLength(1);
  });
});

describe('JobDetail', () => {
  async function mount(onBack = jest.fn()): Promise<jest.Mock> {
    installTransport();
    await render(
      <Provider store={createTestStore()}>
        <JobDetail onBack={onBack} />
      </Provider>,
    );
    return onBack;
  }

  it('shows where to go, what is wrong and the frozen price', async () => {
    replies['GET /masters/me/jobs/current'] = current(job());
    await mount();

    expect(await screen.findByText('Nizami küçəsi 203')).toBeOnTheScreen();
    expect(screen.getByText('Mətbəxdə kran sızır.')).toBeOnTheScreen();
    expect(screen.getByText('67,00 ₼')).toBeOnTheScreen();
    expect(screen.getByText(copy.job.status.ACCEPTED)).toBeOnTheScreen();
  });

  it.each([
    ['ACCEPTED', 'MASTER_ON_THE_WAY'],
    ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED'],
    ['MASTER_ARRIVED', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'COMPLETED'],
  ] as const)('moves a job at %s to %s, and shows what the server then says', async (from, to) => {
    const after = to === 'COMPLETED' ? current(null) : current(job({ status: to }));
    replies['GET /masters/me/jobs/current'] = [current(job({ status: from })), after];
    replies['POST /orders/order-1/transitions'] = { body: { id: 'order-1', status: to } };
    await mount();

    await fireEvent.press(await screen.findByText(copy.job.advance[to]));

    await waitFor(() => {
      expect(posts('/orders/order-1/transitions')).toEqual([{ to }]);
    });
    if (to === 'COMPLETED') {
      expect(await screen.findByText(copy.job.goneTitle)).toBeOnTheScreen();
    } else {
      expect(await screen.findByText(copy.job.status[to])).toBeOnTheScreen();
    }
  });

  it('offers no hand-back once work has started (ADR-0015)', async () => {
    replies['GET /masters/me/jobs/current'] = current(job({ status: 'IN_PROGRESS' }));
    await mount();

    expect(await screen.findByText(copy.job.advance.COMPLETED)).toBeOnTheScreen();
    expect(screen.queryByText(copy.job.handBack)).not.toBeOnTheScreen();
  });

  it('hands the job back only with a reason, and sends that reason', async () => {
    replies['GET /masters/me/jobs/current'] = [current(job()), current(null)];
    replies['POST /orders/order-1/transitions'] = { body: { id: 'order-1', status: 'SEARCHING' } };
    await mount();

    await fireEvent.press(await screen.findByText(copy.job.handBack));
    await fireEvent.press(screen.getByText(copy.job.handBackConfirm));

    expect(await screen.findByText(copy.job.handBackReasonRequired)).toBeOnTheScreen();
    expect(posts('/orders/order-1/transitions')).toHaveLength(0);

    await fireEvent.changeText(
      screen.getByLabelText(copy.job.handBackReason),
      '  Maşın xarab oldu. ',
    );
    await fireEvent.press(screen.getByText(copy.job.handBackConfirm));

    await waitFor(() => {
      expect(posts('/orders/order-1/transitions')).toEqual([
        { to: 'SEARCHING', reason: 'Maşın xarab oldu.' },
      ]);
    });
    expect(await screen.findByText(copy.job.goneTitle)).toBeOnTheScreen();
  });

  it('says plainly when the job is no longer theirs, and offers the way home', async () => {
    replies['GET /masters/me/jobs/current'] = current(null);
    const onBack = await mount();

    expect(await screen.findByText(copy.job.goneTitle)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(copy.job.toHome));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows the order as it now is when a transition is refused', async () => {
    replies['GET /masters/me/jobs/current'] = [current(job()), current(null)];
    replies['POST /orders/order-1/transitions'] = {
      status: 409,
      body: { error: { code: 'INVALID_ORDER_TRANSITION', message: 'no' } },
    };
    await mount();

    await fireEvent.press(await screen.findByText(copy.job.advance.MASTER_ON_THE_WAY));

    // The customer cancelled under the tap: the refusal re-reads the job, and
    // the job read says it is gone.
    expect(await screen.findByText(copy.job.goneTitle)).toBeOnTheScreen();
  });

  it('hands the address to a maps application', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    replies['GET /masters/me/jobs/current'] = current(job());
    await mount();

    await fireEvent.press(await screen.findByText(copy.job.openInMaps));

    expect(spy).toHaveBeenCalledWith(directionsUrl(job()));
    expect(directionsUrl(job())).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=40.372613,49.842717',
    );
    spy.mockRestore();
  });
});
