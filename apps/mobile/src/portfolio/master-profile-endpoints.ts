import type { CursorPage, MasterPublicProfile, PortfolioPost } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * How many posts a further page asks for: the grid reads 30 at a time
 * (ADR-0054 § 2), which is also the server's ceiling (`publicPortfolioQuerySchema`).
 */
export const PORTFOLIO_PAGE_SIZE = 30;

/**
 * How long a profile or a page stays cached once nothing reads it, in seconds.
 *
 * Longer than the app's five minutes (`api-slice.ts`): every URL in them is an
 * immutable public rendition (#304), so unlike the presigned order-photo URLs
 * (`keepUnusedDataFor: 0`) nothing in a cached page expires. Going from the
 * order to the profile and back, or opening the profile again later, draws
 * from the cache. Whether the reader may still see the profile is the server's
 * answer, and the app's usual 30-second freshness still re-asks on a mount.
 */
const PROFILE_KEEP_UNUSED_FOR_SECONDS = 30 * 60;

/** The further pages after the profile's own first one. */
export interface MasterPortfolioArg {
  readonly masterId: string;
  /** The profile's `nextCursor`: where the first further page starts. */
  readonly after: string;
}

/**
 * A master's public profile and the rest of their portfolio (#310, #315).
 *
 * **The profile carries the first page** of posts, so the screen draws its
 * grid from one request. Further pages are an infinite query that starts from
 * the profile's cursor; it is not asked for until the grid nears its end.
 *
 * **Tagged for the master's own edits only.** Nothing a customer does changes
 * a profile; a master who publishes, deletes or changes their avatar (#314)
 * invalidates `MasterProfile`, so their own profile screen redraws.
 */
export const masterProfileApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /masters/:id/profile`. A 404 is every reason the reader may not see it (ADR-0045 § 2). */
    masterProfile: build.query<MasterPublicProfile, string>({
      query: (masterId) => `/masters/${masterId}/profile`,
      keepUnusedDataFor: PROFILE_KEEP_UNUSED_FOR_SECONDS,
      // The master's own edits (#314) invalidate it; a customer's never do.
      providesTags: (_result, _error, masterId) => [{ type: 'MasterProfile', id: masterId }],
    }),

    /**
     * `GET /masters/:id/portfolio`, a page at a time. The cursor is the
     * server's, opaque and never built here. `null` is the first further page,
     * which starts at the profile's own cursor; `undefined` from
     * `getNextPageParam` is RTK Query's "no more pages".
     */
    masterPortfolio: build.infiniteQuery<
      CursorPage<PortfolioPost>,
      MasterPortfolioArg,
      string | null
    >({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
      query: ({ queryArg, pageParam }) => ({
        url: `/masters/${queryArg.masterId}/portfolio`,
        params: { cursor: pageParam ?? queryArg.after, limit: PORTFOLIO_PAGE_SIZE },
      }),
      keepUnusedDataFor: PROFILE_KEEP_UNUSED_FOR_SECONDS,
    }),
  }),
});

export const { useMasterProfileQuery, useMasterPortfolioInfiniteQuery } = masterProfileApi;
