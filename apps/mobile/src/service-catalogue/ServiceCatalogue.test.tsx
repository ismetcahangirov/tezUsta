import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { deviceLocale } from '../lib/device-locale';
import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
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
 * anything that is not a 4xx, twice), so assertions that go through a failure
 * need longer than the one-second default.
 */
const THROUGH_A_RETRY = { timeout: 10_000 };

const PLUMBING: ServiceCategory = {
  id: 'cat-1',
  slug: 'plumbing',
  name: 'Santexnika',
  displayOrder: 0,
};

const ELECTRICAL: ServiceCategory = {
  id: 'cat-2',
  slug: 'electrical',
  name: 'Elektrik',
  displayOrder: 1,
};

const CATEGORIES: CursorPage<ServiceCategory> = { items: [PLUMBING, ELECTRICAL], nextCursor: null };

function service(id: string, name: string, categoryId: string): Service {
  return { id, categoryId, slug: id, name, pricing: { kind: 'inspection' }, displayOrder: 0 };
}

const PLUMBING_SERVICE = service('svc-1', 'Su sızması', PLUMBING.id);
const ELECTRICAL_SERVICE = service('svc-2', 'Rozetka', ELECTRICAL.id);

interface Reply {
  readonly body?: unknown;
  /** Rejects instead of answering — which is what `FETCH_ERROR` really is. */
  readonly transportError?: true;
  /** Never settles, so the request stays in flight. */
  readonly pending?: true;
}

/**
 * Keyed by path + query so each category can behave differently, which is what
 * the category-switching tests below need. `'categories'` is a shorthand key
 * for the categories endpoint.
 */
let replies: Record<string, Reply> = {};

function defaultReply(target: string): Reply {
  if (target.startsWith('/services/categories')) {
    return { body: CATEGORIES };
  }
  if (target.includes(`categoryId=${ELECTRICAL.id}`)) {
    return { body: { items: [ELECTRICAL_SERVICE], nextCursor: null } };
  }
  return { body: { items: [PLUMBING_SERVICE], nextCursor: null } };
}

function replyFor(target: string, pathname: string): Reply {
  const shorthand = pathname.startsWith('/services/categories') ? 'categories' : 'services';
  return replies[target] ?? replies[pathname] ?? replies[shorthand] ?? defaultReply(target);
}

/**
 * Drives the real api slice through the real base query; only `fetch` is faked,
 * the same way `auth-endpoints.test.ts` does it.
 */
function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const reply = replyFor(`${url.pathname}${url.search}`, url.pathname);

    if (reply.pending === true) {
      return new Promise<Response>(() => undefined);
    }
    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(): Promise<AppStore> {
  installTransport();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <ServiceCatalogue />
    </Provider>,
  );
  return store;
}

/** Plumbing first, so its result is in the cache, then Electrical. */
async function openPlumbingThenElectrical(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
  });
  void fireEvent.press(screen.getByRole('button', { name: PLUMBING.name }));

  await waitFor(() => {
    expect(screen.getByText(PLUMBING_SERVICE.name)).toBeOnTheScreen();
  });
  void fireEvent.press(screen.getByRole('button', { name: copy.allCategories }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: ELECTRICAL.name })).toBeOnTheScreen();
  });
  void fireEvent.press(screen.getByRole('button', { name: ELECTRICAL.name }));
}

describe('ServiceCatalogue', () => {
  beforeEach(() => {
    replies = {};
  });

  it('renders the categories the API returned, and holds no list of its own', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
    });
    expect(screen.getByText(ELECTRICAL.name)).toBeOnTheScreen();
  });

  it('announces that it is loading while the request is still in flight', async () => {
    replies = { categories: { pending: true } };
    await mount();

    expect(screen.getByLabelText(copy.loading)).toBeOnTheScreen();
  });

  /**
   * At a cold mount nothing has been attempted and there is no data. Reading
   * "no data" as "it failed" commits a tree saying the catalogue could not
   * load before anything has been tried.
   */
  it('never says the catalogue failed before anything has been attempted', async () => {
    replies = { categories: { pending: true } };
    await mount();

    expect(screen.queryByText(copy.errorTitle)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.errorDescription)).not.toBeOnTheScreen();
  });

  it('opens a category and shows its services', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
    });
    void fireEvent.press(screen.getByRole('button', { name: PLUMBING.name }));

    await waitFor(() => {
      expect(screen.getByText(PLUMBING_SERVICE.name)).toBeOnTheScreen();
    });
    expect(screen.getByRole('button', { name: copy.allCategories })).toBeOnTheScreen();
  });

  /**
   * **The defect this test exists for.** RTK Query's `data` deliberately falls
   * back to the previous argument's result while a new one is in flight, so
   * reading it here left plumbing's services on screen under the heading
   * "Elektrik" — a list that is not the list the customer asked for, with
   * nothing saying so. `currentData` is scoped to the argument on screen.
   */
  it('never shows one category’s services under another category’s heading', async () => {
    replies = { [`/services?categoryId=${ELECTRICAL.id}`]: { pending: true } };
    await mount();
    await openPlumbingThenElectrical();

    await waitFor(() => {
      expect(screen.getByText(ELECTRICAL.name)).toBeOnTheScreen();
    });
    expect(screen.queryByText(PLUMBING_SERVICE.name)).not.toBeOnTheScreen();
    expect(screen.getByLabelText(copy.loading)).toBeOnTheScreen();
  });

  /**
   * The same defect one step worse: with the previous category's rows still on
   * screen, a failed fetch added a banner asserting they were a saved copy of
   * the category now named in the heading.
   */
  it('never captions another category’s rows as this category’s saved copy', async () => {
    replies = { [`/services?categoryId=${ELECTRICAL.id}`]: { transportError: true } };
    await mount();
    await openPlumbingThenElectrical();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.queryByText(copy.staleNotice)).not.toBeOnTheScreen();
    expect(screen.queryByText(PLUMBING_SERVICE.name)).not.toBeOnTheScreen();
  }, 30_000);

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
  }, 30_000);

  it('recovers when the retry succeeds', async () => {
    replies = { categories: { transportError: true } };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);

    replies = {};
    void fireEvent.press(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => {
      expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
  }, 30_000);

  /**
   * The state that is easy to leave out, and the one that matters on a mobile
   * network: the category's own list already loaded, its refresh failed, and
   * replacing a usable screen with an error page would be the wrong trade. The
   * banner is truthful here because the rows on screen really are a stale copy
   * of the thing named in the heading — which is exactly what distinguishes
   * this from the two defects above.
   */
  it('keeps a category’s loaded list on screen when its refresh fails, and says why', async () => {
    const store = await mount();

    await waitFor(() => {
      expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
    });
    void fireEvent.press(screen.getByRole('button', { name: PLUMBING.name }));
    await waitFor(() => {
      expect(screen.getByText(PLUMBING_SERVICE.name)).toBeOnTheScreen();
    });

    // Nothing in the UI forces a refetch inside the 30-second freshness
    // window, so ask for one the way a pull-to-refresh eventually will.
    replies = { services: { transportError: true } };
    await store
      .dispatch(
        serviceCatalogueApi.endpoints.listServices.initiate(
          { locale: deviceLocale(), categoryId: PLUMBING.id },
          { forceRefetch: true },
        ),
      )
      .unwrap()
      .catch(() => undefined);

    await waitFor(() => {
      expect(screen.getByText(copy.staleNotice)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByText(PLUMBING_SERVICE.name)).toBeOnTheScreen();
  }, 30_000);
});
