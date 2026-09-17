import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createAppStore, type AppStore } from '../store';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';
import { serviceCatalogueApi } from './service-catalogue-endpoints';
import { ServiceCatalogue } from './ServiceCatalogue';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/**
 * A retried request waits out a real backoff (`createRetryingBaseQuery` retries
 * anything that is not a 4xx, twice), so the assertions that go through a
 * failure need longer than the one-second default.
 */
const THROUGH_A_RETRY = { timeout: 10_000 };

const CATEGORIES: CursorPage<ServiceCategory> = {
  items: [
    { id: 'cat-1', slug: 'plumbing', name: 'Santexnika', displayOrder: 0 },
    { id: 'cat-2', slug: 'electrical', name: 'Elektrik', displayOrder: 1 },
  ],
  nextCursor: null,
};

const SERVICES: CursorPage<Service> = {
  items: [
    {
      id: 'svc-1',
      categoryId: 'cat-1',
      slug: 'leak-repair',
      name: 'Su sızması',
      pricing: { kind: 'inspection' },
      displayOrder: 0,
    },
  ],
  nextCursor: null,
};

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
  /** Rejects instead of answering — which is what `FETCH_ERROR` really is. */
  readonly transportError?: true;
  /** Never settles, so the request stays in flight and the loading branch stays on screen. */
  readonly pending?: true;
}

let replies: Record<string, Reply> = {};

/**
 * Drives the real api slice through the real base query; only `fetch` is
 * faked, the same way `auth-endpoints.test.ts` does it.
 */
function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const path = request.url.replace('http://api.test', '');
    const key = path.startsWith('/services/categories') ? 'categories' : 'services';
    const reply = replies[key] ?? { body: key === 'categories' ? CATEGORIES : SERVICES };

    if (reply.pending === true) {
      return new Promise<Response>(() => undefined);
    }

    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(): Promise<AppStore> {
  installTransport();
  const store = createAppStore();
  await render(
    <Provider store={store}>
      <ServiceCatalogue />
    </Provider>,
  );
  return store;
}

describe('ServiceCatalogue', () => {
  beforeEach(() => {
    replies = {};
  });

  it('renders the categories the API returned, and holds no list of its own', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Santexnika')).toBeOnTheScreen();
    });
    expect(screen.getByText('Elektrik')).toBeOnTheScreen();
  });

  it('announces that it is loading while the request is still in flight', async () => {
    replies = { categories: { pending: true } };
    await mount();

    expect(screen.getByLabelText(copy.loading)).toBeOnTheScreen();
    expect(screen.queryByText(copy.errorTitle)).not.toBeOnTheScreen();
  });

  it('opens a category and shows its services', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Santexnika')).toBeOnTheScreen();
    });
    void fireEvent.press(screen.getByRole('button', { name: 'Santexnika' }));

    await waitFor(() => {
      expect(screen.getByText('Su sızması')).toBeOnTheScreen();
    });
    expect(screen.getByRole('button', { name: copy.allCategories })).toBeOnTheScreen();
  });

  it('shows the empty state when the catalogue is genuinely empty', async () => {
    replies = { categories: { body: { items: [], nextCursor: null } } };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.emptyTitle)).toBeOnTheScreen();
    });
  });

  it('shows the error state, with a retry, when the first load fails', async () => {
    replies = { categories: { transportError: true } };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByRole('button', { name: copy.retry })).toBeOnTheScreen();
  }, 20_000);

  it('recovers when the retry succeeds', async () => {
    replies = { categories: { transportError: true } };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);

    replies = {};
    void fireEvent.press(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => {
      expect(screen.getByText('Santexnika')).toBeOnTheScreen();
    });
  }, 20_000);

  /**
   * The state that is easy to leave out, and the one that matters on a mobile
   * network: the list already loaded, a refresh failed, and replacing a usable
   * screen with an error page would be the wrong trade.
   */
  it('keeps a loaded catalogue on screen when a refresh fails, and says why', async () => {
    const store = await mount();

    await waitFor(() => {
      expect(screen.getByText('Santexnika')).toBeOnTheScreen();
    });

    replies = { categories: { transportError: true } };
    await store
      .dispatch(
        serviceCatalogueApi.endpoints.listServiceCategories.initiate(undefined, {
          forceRefetch: true,
        }),
      )
      .unwrap()
      .catch(() => undefined);

    await waitFor(() => {
      expect(screen.getByText(copy.staleNotice)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByText('Santexnika')).toBeOnTheScreen();
  }, 20_000);
});
