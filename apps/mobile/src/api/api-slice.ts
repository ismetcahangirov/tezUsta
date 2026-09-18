import { createApi } from '@reduxjs/toolkit/query/react';

import { createAuthBaseQuery } from '../auth/auth-base-query';

/**
 * How long a cached result is considered fresh, in seconds. RTK Query has no
 * `staleTime`: `refetchOnMountOrArgChange` takes the same number and means the
 * same thing at a mount or an argument change.
 */
const FRESH_FOR_SECONDS = 30;

/**
 * How long an unsubscribed result stays in the cache, in seconds — the
 * equivalent of a garbage-collection window.
 */
const KEEP_UNUSED_FOR_SECONDS = 300;

/**
 * The single API slice. Endpoints are **injected by the feature that owns
 * them** through `api.injectEndpoints`, never declared here — the same reason
 * a NestJS module owns its own routes. This file stays a transport policy, not
 * a catalogue of every endpoint in the product.
 *
 * The base query is the authenticated one: every request carries the access
 * token, and a 401 is refreshed and replayed underneath the caller
 * (`src/auth/auth-base-query.ts`). The retry policy it wraps lives in
 * `./base-query.ts` rather than here so that this file can import the auth
 * layer without the auth layer importing this one back — `no-circular` is a
 * CI-failing rule (CLAUDE.md §14).
 *
 * `setupListeners` is deliberately not called anywhere. Refetch-on-focus costs
 * the user mobile data on every app switch, which is not a trade this market
 * rewards (docs/engineering/performance.md).
 *
 * `tagTypes` is the one list a feature's endpoint file is not allowed to
 * extend on its own — a tag name declared nowhere would silently no-op every
 * `invalidatesTags`/`providesTags` that referenced it. `'Address'` is the
 * first entry, added for `src/addresses/addresses-endpoints.ts`; `'Order'`
 * arrives with `src/orders/order-endpoints.ts` (issue #85).
 */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: createAuthBaseQuery(),
  refetchOnMountOrArgChange: FRESH_FOR_SECONDS,
  keepUnusedDataFor: KEEP_UNUSED_FOR_SECONDS,
  refetchOnFocus: false,
  refetchOnReconnect: false,
  tagTypes: ['Address', 'Order'],
  endpoints: () => ({}),
});
