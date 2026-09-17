import type { QueryReturnValue } from '@reduxjs/toolkit/query';
import type { FetchBaseQueryError, FetchBaseQueryMeta } from '@reduxjs/toolkit/query/react';
import type { CursorPage, Service, ServiceCategory } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * How many pages one catalogue read will follow before giving up.
 *
 * A cursor loop is only as safe as its exit condition, and that condition —
 * "the server said `nextCursor` is null" — is the server's to honour. A server
 * that returned the same cursor forever would spin this loop until the device
 * gave out. Twenty pages of fifty is a thousand services, far beyond any
 * catalogue this product plausibly has: reaching the cap means something is
 * wrong, not that a customer has a large catalogue.
 */
const MAX_PAGES = 20;

/**
 * **`locale` is part of the argument, not only of the header, and that is the
 * point.** The response is translated, so the language is part of what
 * identifies a result — RTK Query keys its cache on the argument and knows
 * nothing about headers, so a locale living only in a header would let the
 * cache serve Azerbaijani to a caller who asked for English and call it a hit.
 * This is the client-side counterpart of the server's `Vary: Accept-Language`
 * (ADR-0020).
 */
export interface CatalogueQueryArg {
  readonly locale: string;
}

export interface ServicesQueryArg extends CatalogueQueryArg {
  readonly categoryId?: string;
}

interface PageRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
}

type PageQuery = (
  arg: PageRequest,
) => Promise<QueryReturnValue<unknown, FetchBaseQueryError, FetchBaseQueryMeta>>;

/**
 * Follows `nextCursor` to the end and returns every row as one list.
 *
 * **Reading only the first page is a bug with a delay.** The server's default
 * page is fifty and the launch catalogue is thirty-three, so a first-page-only
 * client works right up until somebody adds the fifty-first service, at which
 * point it silently stops appearing. EPIC 3 exists so that adding a service
 * needs no release; a truncation nobody can see would quietly undo that.
 *
 * The whole catalogue becomes one cache entry rather than a page per entry
 * because that is what the screen wants: a category's services are a list, not
 * a paginated feed. The cursor stays an implementation detail here and never
 * reaches a component.
 */
async function collectPages<T>(
  pageQuery: PageQuery,
  url: string,
  locale: string,
  params: Record<string, string>,
): Promise<QueryReturnValue<readonly T[], FetchBaseQueryError, FetchBaseQueryMeta>> {
  const items: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: QueryReturnValue<unknown, FetchBaseQueryError, FetchBaseQueryMeta> =
      await pageQuery({
        url,
        headers: { 'Accept-Language': locale },
        params: cursor === null ? params : { ...params, cursor },
      });

    if (result.error !== undefined) {
      return { error: result.error };
    }

    const body = result.data as CursorPage<T>;
    items.push(...body.items);

    if (body.nextCursor === null) {
      return { data: items };
    }
    cursor = body.nextCursor;
  }

  // The cap was reached. Returning what we have rather than an error: a
  // truncated catalogue is still usable, and an empty screen is a worse answer
  // to a server misbehaving in a way the customer cannot do anything about.
  return { data: items };
}

/**
 * The catalogue's server state, injected into the one API slice by the feature
 * that owns it (`docs/architecture/frontend-architecture.md` § RTK Query
 * conventions).
 *
 * **The response types are imported, not transcribed.** `@tezusta/types` is
 * the file `apps/api` serves these shapes from, so a contract change is a
 * compile error on both sides at once rather than a runtime surprise on one
 * ([ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)).
 *
 * **No `tagTypes`, and no invalidation.** Nothing in the app writes to the
 * catalogue, so there is no mutation to invalidate against. Freshness comes
 * from the api slice's defaults (`refetchOnMountOrArgChange: 30`,
 * `keepUnusedDataFor: 300`) — the right shape for data that changes on a human
 * timescale ([ADR-0017](docs/decisions/ADR-0017-state-management.md)). The
 * server caches these reads for a minute of its own accord (ADR-0020), so a
 * refetch usually costs Redis rather than Postgres.
 *
 * Both endpoints use `queryFn` rather than `query`, because one logical read
 * is several HTTP requests — see {@link collectPages}. The base query they are
 * handed is the same retrying one every other endpoint uses.
 */
export const serviceCatalogueApi = api.injectEndpoints({
  endpoints: (build) => ({
    listServiceCategories: build.query<readonly ServiceCategory[], CatalogueQueryArg>({
      queryFn: async (arg, _api, _extraOptions, baseQuery) =>
        collectPages<ServiceCategory>(
          baseQuery as unknown as PageQuery,
          '/services/categories',
          arg.locale,
          {},
        ),
    }),

    /**
     * `categoryId: undefined` means the whole catalogue and is a different
     * cache entry from any particular category — RTK Query keys on the
     * argument, so the two never overwrite one another.
     */
    listServices: build.query<readonly Service[], ServicesQueryArg>({
      queryFn: async (arg, _api, _extraOptions, baseQuery) =>
        collectPages<Service>(
          baseQuery as unknown as PageQuery,
          '/services',
          arg.locale,
          arg.categoryId === undefined ? {} : { categoryId: arg.categoryId },
        ),
    }),
  }),
});

export const { useListServiceCategoriesQuery, useListServicesQuery } = serviceCatalogueApi;
