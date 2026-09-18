import type { Address } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createAppStore, type AppStore } from '../store';
import { ADDRESSES_COPY as copy } from './addresses-copy';
import { Addresses } from './Addresses';
import { addressesApi } from './addresses-endpoints';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

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

const HOME = address({ id: 'addr-1', label: 'Ev', isDefault: true });
const OFFICE = address({
  id: 'addr-2',
  label: 'İş',
  formattedAddress: 'Rəşid Behbudov küçəsi 5',
  isDefault: false,
});

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportError?: true;
}

let replies: Record<string, Reply> = {};

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function defaultReply(method: string, pathname: string): Reply {
  if (method === 'GET' && pathname === '/addresses') {
    return { body: [HOME, OFFICE] };
  }
  return { status: 200, body: {} };
}

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
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

async function mount(): Promise<AppStore> {
  installTransport();
  const store = createAppStore();
  await render(
    <Provider store={store}>
      <Addresses />
    </Provider>,
  );
  return store;
}

describe('Addresses', () => {
  beforeEach(() => {
    replies = {};
  });

  it('announces that it is loading while the first request is in flight', async () => {
    global.fetch = () => new Promise<Response>(() => undefined);
    const store = createAppStore();
    await render(
      <Provider store={store}>
        <Addresses />
      </Provider>,
    );

    expect(screen.getByLabelText(copy.loading)).toBeOnTheScreen();
  });

  it('renders the addresses the API returned, default first as given', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Ev')).toBeOnTheScreen();
    });
    expect(screen.getByText('Defolt')).toBeOnTheScreen();
    expect(screen.getByText('İş')).toBeOnTheScreen();
  });

  it('shows an empty state that says what to do next when there are none', async () => {
    replies[routeKey('GET', '/addresses')] = { body: [] };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.emptyTitle)).toBeOnTheScreen();
    });
    // Two ways to add one on this screen once it is empty: the header icon
    // (always present) and the empty state's own call to action.
    expect(screen.getAllByRole('button', { name: copy.addAction }).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  /**
   * The API answers 404 for "no addresses you can see" and for "you have no
   * customer profile yet" alike — the same deliberate 404-not-403 that stops
   * `GET /addresses/:id` confirming a stranger's row exists. A brand-new
   * customer therefore meets this on their very first visit, and the generic
   * error would tell them to check an internet connection that is working,
   * behind a retry button that can never succeed.
   */
  it('treats a 404 on the list as "you have none yet", not as a failure', async () => {
    replies[routeKey('GET', '/addresses')] = {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } },
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.emptyTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.errorTitle)).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.retry })).not.toBeOnTheScreen();
  });

  it('shows the error state, with a retry, when the first load fails', async () => {
    replies[routeKey('GET', '/addresses')] = { transportError: true };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByRole('button', { name: copy.retry })).toBeOnTheScreen();
  }, 30_000);

  it('keeps a loaded list on screen when a refresh fails, and says why', async () => {
    const store = await mount();
    await waitFor(() => {
      expect(screen.getByText('Ev')).toBeOnTheScreen();
    });

    replies[routeKey('GET', '/addresses')] = { transportError: true };
    // Nothing in the UI forces a refetch inside the freshness window, so ask
    // for one directly — the same technique `ServiceCatalogue.test.tsx` uses
    // for its equivalent case.
    store.dispatch(addressesApi.util.invalidateTags([{ type: 'Address', id: 'LIST' }]));

    await waitFor(() => {
      expect(screen.getByText(copy.staleNotice)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByText('Ev')).toBeOnTheScreen();
  }, 30_000);

  it('adds an address once it has been found, and shows it once the server confirms it', async () => {
    await mount();
    await waitFor(() => {
      expect(screen.getByText('Ev')).toBeOnTheScreen();
    });

    const created = address({
      id: 'addr-3',
      label: null,
      formattedAddress: 'Zərifə Əliyeva küçəsi 12',
      isDefault: false,
    });
    replies[routeKey('POST', '/geocode/forward')] = {
      body: { status: 'ok', latitude: 40.41, longitude: 49.86, placeId: null },
    };
    replies[routeKey('POST', '/addresses')] = { status: 201, body: created };
    replies[routeKey('GET', '/addresses')] = { body: [HOME, OFFICE, created] };

    await fireEvent.press(screen.getByRole('button', { name: copy.addAction }));
    await fireEvent.changeText(screen.getByLabelText(copy.addressField), created.formattedAddress);
    await fireEvent.press(screen.getByRole('button', { name: copy.findAddressAction }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: copy.save })).not.toBeDisabled();
    }, THROUGH_A_RETRY);
    await fireEvent.press(screen.getByRole('button', { name: copy.save }));

    await waitFor(() => {
      expect(screen.getByText(created.formattedAddress)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    // The sheet closed rather than sitting on top of the now-visible list.
    expect(screen.queryByText(copy.formTitleAdd)).not.toBeOnTheScreen();
  }, 30_000);

  /**
   * Issue #90's central behaviour: promoting a survivor after a delete is the
   * server's decision. This proves the screen renders whatever `GET
   * /addresses` answers with next rather than assuming "the other one" became
   * the default.
   */
  it('reflects the server’s own choice of new default after deleting the old one', async () => {
    await mount();
    await waitFor(() => {
      expect(screen.getByText('Ev')).toBeOnTheScreen();
    });

    replies[routeKey('DELETE', '/addresses/addr-1')] = { status: 204, body: undefined };
    // The server's real rule promotes the oldest survivor — here, deliberately
    // not the only other address in the list, so a client that guessed "the
    // remaining one" would still pass by accident. It is a third address
    // instead, standing in for "whatever the server actually decided".
    const promoted = address({ id: 'addr-9', label: 'Yay evi', isDefault: true });
    replies[routeKey('GET', '/addresses')] = { body: [promoted, OFFICE] };

    await fireEvent.press(screen.getByRole('button', { name: 'Ev ünvanını sil' }));

    await waitFor(() => {
      expect(screen.getByText('Yay evi')).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.queryByText('Ev')).not.toBeOnTheScreen();
  }, 30_000);

  /**
   * The API answers 404, never 403, for an address that is not the caller's.
   * The screen must not present that as an account problem.
   */
  it('does not present a 404 on a row action as an account problem', async () => {
    await mount();
    await waitFor(() => {
      expect(screen.getByText('Ev')).toBeOnTheScreen();
    });

    replies[routeKey('DELETE', '/addresses/addr-1')] = {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'req-1' } },
    };

    await fireEvent.press(screen.getByRole('button', { name: 'Ev ünvanını sil' }));

    await waitFor(() => {
      expect(screen.getByText(copy.notFoundError)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.queryByText(/hesab/i)).not.toBeOnTheScreen();
  }, 30_000);
});
