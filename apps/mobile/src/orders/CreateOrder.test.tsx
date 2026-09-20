import type { Address, Order, Service } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { CreateOrder } from './CreateOrder';
import { ORDERS_COPY as copy } from './orders-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(() =>
    Promise.resolve({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg', mimeType: 'image/jpeg' }],
    }),
  ),
}));

const SERVICE_ID = 'svc-1';

const SERVICE: Service = {
  id: SERVICE_ID,
  categoryId: 'cat-1',
  slug: 'kran-temiri',
  name: 'Kran təmiri',
  description: null,
  pricing: { kind: 'fixed', basePriceMinor: 1500, currency: 'AZN' },
  displayOrder: 1,
} as unknown as Service;

const HOME: Address = {
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
};

const ORDER: Order = {
  id: 'order-1',
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
};

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportError?: true;
}

let replies: Record<string, Reply> = {};
let createBodies: unknown[] = [];

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function defaultReply(method: string, pathname: string): Reply {
  if (method === 'GET' && pathname === '/addresses') {
    return { body: [HOME] };
  }
  if (method === 'GET' && pathname === `/services/${SERVICE_ID}`) {
    return { body: SERVICE };
  }
  if (method === 'GET' && pathname === `/services/${SERVICE_ID}/price-range`) {
    return {
      body: { pricingKind: 'fixed', range: { minMinor: 1500, maxMinor: 4500, currency: 'AZN' } },
    };
  }
  if (method === 'POST' && pathname === '/orders') {
    return { status: 201, body: ORDER };
  }
  return { status: 200, body: {} };
}

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/orders') {
      createBodies.push(await request.clone().json());
    }

    const reply =
      replies[routeKey(request.method, url.pathname)] ?? defaultReply(request.method, url.pathname);

    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

async function mount(): Promise<void> {
  installTransport();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <CreateOrder serviceId={SERVICE_ID} onClose={jest.fn()} />
    </Provider>,
  );
}

/** Walks the flow to the confirmation step with a valid description and address. */
async function reachConfirmation(description = 'Mətbəxdə kran sızır.'): Promise<void> {
  await mount();

  await fireEvent.changeText(screen.getByPlaceholderText(copy.descriptionPlaceholder), description);
  await fireEvent.press(screen.getByRole('button', { name: copy.next }));

  await waitFor(() => {
    expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
  });
  await fireEvent.press(screen.getByRole('button', { name: HOME.formattedAddress }));
  await fireEvent.press(screen.getByRole('button', { name: copy.next }));

  await waitFor(() => {
    expect(screen.getByText(copy.confirmTitle)).toBeOnTheScreen();
  });
}

describe('CreateOrder', () => {
  beforeEach(() => {
    replies = {};
    createBodies = [];
  });

  it('will not let the customer past a description too short to act on', async () => {
    await mount();

    const next = screen.getByRole('button', { name: copy.next });
    expect(next).toBeDisabled();

    await fireEvent.changeText(screen.getByPlaceholderText(copy.descriptionPlaceholder), 'su');
    expect(screen.getByRole('button', { name: copy.next })).toBeDisabled();

    await fireEvent.changeText(
      screen.getByPlaceholderText(copy.descriptionPlaceholder),
      'Mətbəxdə kran sızır, su dayanmır.',
    );
    expect(screen.getByRole('button', { name: copy.next })).not.toBeDisabled();
  });

  it('will not let the customer past the address step until one is chosen', async () => {
    await mount();

    await fireEvent.changeText(
      screen.getByPlaceholderText(copy.descriptionPlaceholder),
      'Mətbəxdə kran sızır, su dayanmır.',
    );
    await fireEvent.press(screen.getByRole('button', { name: copy.next }));

    await waitFor(() => {
      expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
    });
    expect(screen.getByRole('button', { name: copy.next })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: HOME.formattedAddress }));
    expect(screen.getByRole('button', { name: copy.next })).not.toBeDisabled();
  });

  /**
   * The estimate must never read as a price the customer is agreeing to pay —
   * the real one is frozen when a master accepts (ADR-0013). The note is part
   * of the assertion, not decoration.
   */
  it('shows the range as an estimate, and says who really sets the price', async () => {
    await reachConfirmation();

    expect(screen.getByText(copy.priceEstimateLabel)).toBeOnTheScreen();
    expect(screen.getByText('15.00 – 45.00 AZN')).toBeOnTheScreen();
    expect(screen.getByText(copy.priceEstimateNote)).toBeOnTheScreen();
  });

  it('says the price comes after inspection, before the customer commits', async () => {
    replies[routeKey('GET', `/services/${SERVICE_ID}/price-range`)] = {
      body: { pricingKind: 'inspection' },
    };
    await reachConfirmation();

    expect(screen.getByText(copy.priceInspection)).toBeOnTheScreen();
    expect(screen.queryByText(copy.priceEstimateLabel)).not.toBeOnTheScreen();
  });

  it('creates the order without ever sending a price', async () => {
    await reachConfirmation();

    await fireEvent.press(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() => {
      expect(screen.getByText(copy.createdTitle)).toBeOnTheScreen();
    });

    expect(createBodies).toHaveLength(1);
    const body = createBodies[0] as Record<string, unknown>;
    expect(body).toMatchObject({ serviceId: SERVICE_ID, addressId: HOME.id });
    expect(body).not.toHaveProperty('priceMinor');
    expect(body).not.toHaveProperty('status');
    expect(typeof body['idempotencyKey']).toBe('string');
  });

  /**
   * The whole point of the key. A retry of the same attempt must carry the
   * same one, or the customer ends up with two masters on their way to the
   * same tap.
   */
  it('reuses one idempotency key across a retry of the same attempt', async () => {
    replies[routeKey('POST', '/orders')] = { transportError: true };
    await reachConfirmation();

    await fireEvent.press(screen.getByRole('button', { name: copy.submit }));
    await waitFor(
      () => {
        expect(screen.getByText(copy.offlineError)).toBeOnTheScreen();
      },
      { timeout: 10_000 },
    );

    delete replies[routeKey('POST', '/orders')];
    await fireEvent.press(screen.getByRole('button', { name: copy.submit }));
    await waitFor(() => {
      expect(screen.getByText(copy.createdTitle)).toBeOnTheScreen();
    });

    const keys = createBodies.map((body) => (body as Record<string, unknown>)['idempotencyKey']);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
  }, 30_000);

  it('keeps what the customer typed when the server refuses the order', async () => {
    replies[routeKey('POST', '/orders')] = {
      status: 422,
      body: { error: { code: 'VALIDATION_FAILED', message: 'Validation failed.', requestId: 'r' } },
    };
    await reachConfirmation();

    await fireEvent.press(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() => {
      expect(screen.getByText(copy.submitFailed)).toBeOnTheScreen();
    });
    // Still on the confirmation step, with the order not created.
    expect(screen.getByText(copy.confirmTitle)).toBeOnTheScreen();
    expect(screen.queryByText(copy.createdTitle)).not.toBeOnTheScreen();
  });

  /**
   * `docs/product/customer-flow.md` is explicit: if the photo upload fails,
   * the order can still be created without it.
   */
  it('leaves the order creatable when a photo fails to upload', async () => {
    replies[routeKey('POST', '/orders/photos/presign')] = { transportError: true };
    await mount();

    await fireEvent.changeText(
      screen.getByPlaceholderText(copy.descriptionPlaceholder),
      'Mətbəxdə kran sızır, su dayanmır.',
    );
    await fireEvent.press(screen.getByRole('button', { name: copy.addPhoto }));

    await waitFor(
      () => {
        expect(screen.getByText(copy.photoFailed)).toBeOnTheScreen();
      },
      { timeout: 10_000 },
    );
    expect(screen.getByRole('button', { name: copy.next })).not.toBeDisabled();
  }, 30_000);

  it('tells the customer to add an address before ordering, rather than failing', async () => {
    replies[routeKey('GET', '/addresses')] = { body: [] };
    await mount();

    await fireEvent.changeText(
      screen.getByPlaceholderText(copy.descriptionPlaceholder),
      'Mətbəxdə kran sızır, su dayanmır.',
    );
    await fireEvent.press(screen.getByRole('button', { name: copy.next }));

    await waitFor(() => {
      expect(screen.getByText(copy.addressEmptyTitle)).toBeOnTheScreen();
    });
    expect(screen.getByRole('button', { name: copy.next })).toBeDisabled();
  });

  it('reads a 404 on the address list as "you have none", not as a failure', async () => {
    replies[routeKey('GET', '/addresses')] = {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } },
    };
    await mount();

    await fireEvent.changeText(
      screen.getByPlaceholderText(copy.descriptionPlaceholder),
      'Mətbəxdə kran sızır, su dayanmır.',
    );
    await fireEvent.press(screen.getByRole('button', { name: copy.next }));

    await waitFor(() => {
      expect(screen.getByText(copy.addressEmptyTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.addressLoadFailed)).not.toBeOnTheScreen();
  });
});
