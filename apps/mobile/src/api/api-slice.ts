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
 * arrives with `src/orders/order-endpoints.ts` (issue #85); `'Customer'` with
 * `src/customers/customers-endpoints.ts` (issue #94), whose single
 * `{ type: 'Customer', id: 'ME' }` is what a created profile invalidates so
 * the gate re-reads the server's answer instead of a client's guess.
 *
 * `'MasterOffer'` was declared ahead of its provider (issue #170) so the
 * socket's `order:offer` frame had somewhere to land; the master's feed now
 * provides it, and `'MasterJob'` — the job the master is on — arrives with it
 * (issue #199, `src/master-jobs/master-jobs-endpoints.ts`).
 *
 * `'Conversation'` is one order's conversation and its history (issue #182,
 * `src/conversation/conversation-endpoints.ts`): the socket patches it frame
 * by frame, and a reconnection invalidates it so history is re-read rather
 * than replayed (ADR-0033 § 3).
 *
 * `'Review'` is one order's reviews as the caller may see them (issue #227,
 * `src/reviews/reviews-endpoints.ts`), keyed by order id: a submit or an edit
 * invalidates it, and every prompt card reading the same order hides at once.
 */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: createAuthBaseQuery(),
  refetchOnMountOrArgChange: FRESH_FOR_SECONDS,
  keepUnusedDataFor: KEEP_UNUSED_FOR_SECONDS,
  refetchOnFocus: false,
  refetchOnReconnect: false,
  tagTypes: ['Address', 'Conversation', 'Customer', 'MasterJob', 'MasterOffer', 'Order', 'Review'],
  endpoints: () => ({}),
});
