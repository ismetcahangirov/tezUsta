import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';

import { api } from '../api/api-slice';
import { deviceLocale } from '../lib/device-locale';

/**
 * Asks the server for names in the language the phone is set to.
 *
 * React Native's `fetch` sets no `Accept-Language` of its own, and the API
 * falls back to Azerbaijani when the header is absent (ADR-0019) — so without
 * this, a customer whose phone is in English would be shown Azerbaijani
 * category names that the server was perfectly able to translate.
 *
 * Read per request rather than once at module scope: the device's language can
 * change while the app is running, and RTK Query would otherwise keep serving
 * the cached result of a header nobody sends any more.
 */
function languageHeaders(): Record<string, string> {
  return { 'Accept-Language': deviceLocale() };
}

/**
 * The catalogue's server state, injected into the one API slice by the feature
 * that owns it (`docs/architecture/frontend-architecture.md` § RTK Query
 * conventions).
 *
 * **The response types are imported, not transcribed.** `@tezusta/types` is
 * the same file `apps/api` serves these shapes from, so a change to the
 * contract is a compile error on both sides at once rather than a runtime
 * surprise on one ([ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)).
 *
 * **No `tagTypes`, and no invalidation.** Nothing in the app writes to the
 * catalogue — there is no mutation to invalidate against. Freshness comes from
 * the api slice's own defaults (`refetchOnMountOrArgChange: 30`,
 * `keepUnusedDataFor: 300`), which is the right shape for data that changes on
 * a human timescale: a screen that mounts within thirty seconds of the last
 * one reuses the result instead of spending the customer's mobile data on
 * thirty-three rows that did not change ([ADR-0017](docs/decisions/ADR-0017-state-management.md)).
 *
 * The server caches these reads for a minute of its own accord (ADR-0020), so
 * a refetch the app does decide to make is usually answered from Redis rather
 * than Postgres.
 */
export const serviceCatalogueApi = api.injectEndpoints({
  endpoints: (build) => ({
    listServiceCategories: build.query<CursorPage<ServiceCategory>, void>({
      query: () => ({ url: '/services/categories', headers: languageHeaders() }),
    }),

    /**
     * `categoryId: undefined` means the whole catalogue, and is a different
     * cache entry from any particular category — RTK Query keys on the
     * argument, so the two never overwrite one another.
     */
    listServices: build.query<CursorPage<Service>, { readonly categoryId?: string }>({
      query: ({ categoryId }) => ({
        url: '/services',
        headers: languageHeaders(),
        // Spread rather than `params: undefined`: `exactOptionalPropertyTypes`
        // treats an explicit `undefined` as a value, and `fetchBaseQuery`'s
        // `params` is optional but not nullable.
        ...(categoryId === undefined ? {} : { params: { categoryId } }),
      }),
    }),
  }),
});

export const { useListServiceCategoriesQuery, useListServicesQuery } = serviceCatalogueApi;
