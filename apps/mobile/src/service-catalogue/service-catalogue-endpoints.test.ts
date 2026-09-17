import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';

import { createAppStore, type AppStore } from '../store';
import { serviceCatalogueApi } from './service-catalogue-endpoints';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const CATEGORIES: CursorPage<ServiceCategory> = {
  items: [{ id: 'cat-1', slug: 'plumbing', name: 'Santexnika', displayOrder: 0 }],
  nextCursor: null,
};

const SERVICES: CursorPage<Service> = {
  items: [
    {
      id: 'svc-1',
      categoryId: 'cat-1',
      slug: 'leak-repair',
      name: 'Su sızması',
      pricing: { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
      displayOrder: 0,
    },
  ],
  nextCursor: null,
};

let calls: string[] = [];

/**
 * Stands in for the API on the global `fetch`, so the real api slice, the real
 * base query and the real retry policy all run — only the network is faked.
 * Mirrors `auth-endpoints.test.ts`.
 */
function installTransport(): void {
  calls = [];

  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const path = request.url.replace('http://api.test', '');
    calls.push(path);

    const body = path.startsWith('/services/categories') ? CATEGORIES : SERVICES;

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

describe('the service catalogue endpoints', () => {
  let store: AppStore;

  beforeEach(() => {
    installTransport();
    store = createAppStore();
  });

  it('reads the categories from the API', async () => {
    const result = await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate())
      .unwrap();

    expect(calls).toEqual(['/services/categories']);
    expect(result.items[0]?.name).toBe('Santexnika');
  });

  it('asks for the whole catalogue when no category is chosen', async () => {
    await store.dispatch(serviceCatalogueApi.endpoints.listServices.initiate({})).unwrap();

    expect(calls).toEqual(['/services']);
  });

  it('passes the category through as a query parameter', async () => {
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ categoryId: 'cat-1' }))
      .unwrap();

    expect(calls).toEqual(['/services?categoryId=cat-1']);
  });

  /**
   * The two arguments are different cache entries. If they shared one, opening
   * a category would overwrite the full list and going back would show the
   * category's services under the wrong heading.
   */
  it('keeps the filtered and unfiltered lists as separate cache entries', async () => {
    await store.dispatch(serviceCatalogueApi.endpoints.listServices.initiate({})).unwrap();
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ categoryId: 'cat-1' }))
      .unwrap();

    expect(calls).toEqual(['/services', '/services?categoryId=cat-1']);
  });

  it('sends no Authorization header, because the catalogue needs no account', async () => {
    let authorization: string | null = 'not-checked';
    global.fetch = ((input: Request | string): Promise<Response> => {
      const request = typeof input === 'string' ? new Request(input) : input;
      authorization = request.headers.get('Authorization');
      return Promise.resolve(
        new Response(JSON.stringify(CATEGORIES), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    await store.dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate()).unwrap();

    expect(authorization).toBeNull();
  });
});
