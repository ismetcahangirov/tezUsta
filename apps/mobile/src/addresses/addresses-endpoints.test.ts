import type { Address } from '@tezusta/types';
import { waitFor } from '@testing-library/react-native';

import { type AppStore } from '../store';
import { createTestStore } from '../../test/support/test-store';
import { addressesApi } from './addresses-endpoints';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

function address(overrides: Partial<Address> = {}): Address {
  return {
    id: 'addr-1',
    label: null,
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
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: Call[] = [];
let replies: Record<string, { status: number; body: unknown }> = {};

function key(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function installTransport(): void {
  calls = [];
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const method = request.method;
    const bodyText = await request.text();
    const body: unknown = bodyText === '' ? undefined : JSON.parse(bodyText);
    calls.push({ method, path: url.pathname, body });

    const reply = replies[key(method, url.pathname)] ?? { status: 200, body: {} };
    return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('the saved-addresses endpoints', () => {
  let store: AppStore;

  beforeEach(() => {
    replies = {};
    installTransport();
    store = createTestStore();
  });

  it('reads the customer’s addresses from the API', async () => {
    const home = address({ id: 'addr-1', isDefault: true });
    replies[key('GET', '/addresses')] = { status: 200, body: [home] };

    const result = await store.dispatch(addressesApi.endpoints.listAddresses.initiate()).unwrap();

    expect(result).toEqual([home]);
    expect(calls).toEqual([{ method: 'GET', path: '/addresses', body: undefined }]);
  });

  it('creates an address with exactly the body it was given', async () => {
    const created = address({ id: 'addr-2', isDefault: false });
    replies[key('POST', '/addresses')] = { status: 201, body: created };

    const body = {
      formattedAddress: 'Rəşid Behbudov küçəsi 5',
      building: '5',
      latitude: 40.4,
      longitude: 49.9,
    };
    const result = await store
      .dispatch(addressesApi.endpoints.createAddress.initiate(body))
      .unwrap();

    expect(result).toEqual(created);
    expect(calls).toEqual([{ method: 'POST', path: '/addresses', body }]);
  });

  it('updates an address by id, sending only the patch', async () => {
    const updated = address({ id: 'addr-1', isDefault: true, floor: '5' });
    replies[key('PATCH', '/addresses/addr-1')] = { status: 200, body: updated };

    const result = await store
      .dispatch(
        addressesApi.endpoints.updateAddress.initiate({ id: 'addr-1', patch: { floor: '5' } }),
      )
      .unwrap();

    expect(result).toEqual(updated);
    expect(calls).toEqual([{ method: 'PATCH', path: '/addresses/addr-1', body: { floor: '5' } }]);
  });

  it('deletes an address by id', async () => {
    replies[key('DELETE', '/addresses/addr-1')] = { status: 204, body: undefined };

    await store.dispatch(addressesApi.endpoints.deleteAddress.initiate('addr-1')).unwrap();

    expect(calls).toEqual([{ method: 'DELETE', path: '/addresses/addr-1', body: undefined }]);
  });

  it('asks the geocoder for exactly the text it was given', async () => {
    replies[key('POST', '/geocode/forward')] = {
      status: 200,
      body: { status: 'ok', latitude: 40.4, longitude: 49.9, placeId: null },
    };

    const result = await store
      .dispatch(addressesApi.endpoints.forwardGeocode.initiate('Nizami küçəsi 203'))
      .unwrap();

    expect(result).toEqual({ status: 'ok', latitude: 40.4, longitude: 49.9, placeId: null });
    expect(calls).toEqual([
      { method: 'POST', path: '/geocode/forward', body: { address: 'Nizami küçəsi 203' } },
    ]);
  });

  /**
   * The defect issue #90 explicitly rules out: guessing which address became
   * the default after a delete. This proves the client does not try — it
   * refetches the list, and a subscriber sees whatever the server answers
   * with next, not a locally patched guess.
   */
  it('refetches an active list subscription after a delete settles, rather than patching it locally', async () => {
    const home = address({ id: 'addr-1', isDefault: true });
    const office = address({ id: 'addr-2', isDefault: false });
    replies[key('GET', '/addresses')] = { status: 200, body: [home, office] };
    replies[key('DELETE', '/addresses/addr-1')] = { status: 204, body: undefined };

    const subscription = store.dispatch(addressesApi.endpoints.listAddresses.initiate());
    await subscription;

    // The server would promote `office` to default on this delete; the point
    // here is only that the client asks again rather than assuming that.
    replies[key('GET', '/addresses')] = {
      status: 200,
      body: [{ ...office, isDefault: true }],
    };

    await store.dispatch(addressesApi.endpoints.deleteAddress.initiate('addr-1')).unwrap();

    // Invalidation dispatches the refetch asynchronously — it is not settled
    // the instant the delete's own request resolves — so this polls briefly
    // rather than asserting immediately.
    await waitFor(() => {
      expect(
        calls.filter((call) => call.method === 'GET' && call.path === '/addresses'),
      ).toHaveLength(2);
    });
    const cached = addressesApi.endpoints.listAddresses.select()(store.getState()).data;
    expect(cached).toEqual([{ ...office, isDefault: true }]);

    subscription.unsubscribe();
  });
});
