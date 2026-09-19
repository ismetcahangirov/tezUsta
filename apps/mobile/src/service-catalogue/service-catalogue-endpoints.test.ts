import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { serviceCatalogueApi } from './service-catalogue-endpoints';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const LOCALE = 'az-AZ';

function category(id: string, order: number): ServiceCategory {
  return { id, slug: `cat-${id}`, name: `Kateqoriya ${id}`, displayOrder: order };
}

function service(id: string, order: number): Service {
  return {
    id,
    categoryId: 'cat-1',
    slug: `svc-${id}`,
    name: `Xidmət ${id}`,
    pricing: { kind: 'inspection' },
    displayOrder: order,
  };
}

interface Call {
  readonly path: string;
  readonly acceptLanguage: string | null;
  readonly authorization: string | null;
}

let calls: Call[] = [];
/** Keyed by path-without-query, in the order the endpoint will ask for them. */
let pages: Record<string, CursorPage<unknown>[]> = {};

function installTransport(): void {
  calls = [];
  const served: Record<string, number> = {};

  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const path = url.pathname;

    calls.push({
      path: `${path}${url.search}`,
      acceptLanguage: request.headers.get('Accept-Language'),
      authorization: request.headers.get('Authorization'),
    });

    const queue = pages[path] ?? [{ items: [], nextCursor: null }];
    const index = served[path] ?? 0;
    served[path] = index + 1;
    const body = queue[Math.min(index, queue.length - 1)];

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
    pages = {};
    installTransport();
    store = createTestStore();
  });

  it('reads the categories from the API', async () => {
    pages = { '/services/categories': [{ items: [category('cat-1', 0)], nextCursor: null }] };

    const result = await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate({ locale: LOCALE }))
      .unwrap();

    expect(result.map((item) => item.id)).toEqual(['cat-1']);
  });

  it('asks for the whole catalogue when no category is chosen', async () => {
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ locale: LOCALE }))
      .unwrap();

    expect(calls.map((call) => call.path)).toEqual(['/services']);
  });

  it('passes the category through as a query parameter', async () => {
    await store
      .dispatch(
        serviceCatalogueApi.endpoints.listServices.initiate({
          locale: LOCALE,
          categoryId: 'cat-1',
        }),
      )
      .unwrap();

    expect(calls.map((call) => call.path)).toEqual(['/services?categoryId=cat-1']);
  });

  /**
   * The catalogue is thirty-three rows against a fifty-row page today, so a
   * first-page-only client looks correct and stops being correct the day
   * somebody adds the fifty-first service. That is the whole point of EPIC 3 —
   * adding a service must need no release — so the paging is tested rather
   * than assumed.
   */
  it('follows nextCursor to the end and returns every row as one list', async () => {
    pages = {
      '/services': [
        { items: [service('s1', 0), service('s2', 1)], nextCursor: 'cursor-a' },
        { items: [service('s3', 2)], nextCursor: 'cursor-b' },
        { items: [service('s4', 3)], nextCursor: null },
      ],
    };

    const result = await store
      .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ locale: LOCALE }))
      .unwrap();

    expect(result.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(calls.map((call) => call.path)).toEqual([
      '/services',
      '/services?cursor=cursor-a',
      '/services?cursor=cursor-b',
    ]);
  });

  it('carries the category filter into every page, not just the first', async () => {
    pages = {
      '/services': [
        { items: [service('s1', 0)], nextCursor: 'cursor-a' },
        { items: [service('s2', 1)], nextCursor: null },
      ],
    };

    await store
      .dispatch(
        serviceCatalogueApi.endpoints.listServices.initiate({
          locale: LOCALE,
          categoryId: 'cat-1',
        }),
      )
      .unwrap();

    expect(calls.every((call) => call.path.includes('categoryId=cat-1'))).toBe(true);
  });

  /**
   * A cursor loop's exit condition belongs to the server. A server that
   * returned the same cursor forever would otherwise spin this until the
   * device gave out.
   */
  it('stops rather than looping forever when the server never ends the list', async () => {
    pages = { '/services': [{ items: [service('s1', 0)], nextCursor: 'never-ends' }] };

    const result = await store
      .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ locale: LOCALE }))
      .unwrap();

    expect(calls.length).toBeLessThanOrEqual(20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('surfaces a failure instead of returning a half-read list', async () => {
    pages = { '/services': [{ items: [service('s1', 0)], nextCursor: 'cursor-a' }] };
    let requests = 0;
    global.fetch = (): Promise<Response> => {
      requests += 1;
      if (requests === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [service('s1', 0)], nextCursor: 'cursor-a' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    };

    await expect(
      store
        .dispatch(serviceCatalogueApi.endpoints.listServices.initiate({ locale: LOCALE }))
        .unwrap(),
    ).rejects.toBeDefined();
  }, 20_000);

  it('asks the server for names in the caller`s language', async () => {
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate({ locale: 'en-GB' }))
      .unwrap();

    expect(calls[0]?.acceptLanguage).toBe('en-GB');
  });

  /**
   * The language is part of what identifies a result, so it has to be part of
   * the cache key. A locale that lived only in the header would let RTK Query
   * answer an English request from an Azerbaijani cache entry and call it a
   * hit — the client-side counterpart of the server's `Vary: Accept-Language`.
   */
  it('keeps two languages as separate cache entries', async () => {
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate({ locale: 'az-AZ' }))
      .unwrap();
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate({ locale: 'en-GB' }))
      .unwrap();

    expect(calls.map((call) => call.acceptLanguage)).toEqual(['az-AZ', 'en-GB']);
  });

  /**
   * The catalogue needs no account, but it goes through the app's one
   * authenticated base query, so a signed-in customer does send their token
   * and a signed-out one sends nothing. Recorded rather than asserted as
   * "sends no Authorization header": the old wording was true only because the
   * keychain mock above returns null, which proves nothing about the endpoint.
   */
  it('sends no Authorization header when nobody is signed in', async () => {
    await store
      .dispatch(serviceCatalogueApi.endpoints.listServiceCategories.initiate({ locale: LOCALE }))
      .unwrap();

    expect(calls[0]?.authorization).toBeNull();
  });
});
