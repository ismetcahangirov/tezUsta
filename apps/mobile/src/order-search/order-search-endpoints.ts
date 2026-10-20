import type { OrderSearchProgress } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The search radar's tag: a sub-resource of the order, the shape
 * `orderPhotos` uses. Under `Order`, so the reconnect's blanket
 * `invalidateTags(['Order'])` re-reads it after a gap (a missed
 * `order:search-wave` is not replayed), and the frame itself invalidates
 * exactly this one.
 */
export function orderSearchTag(orderId: string): { type: 'Order'; id: string } {
  return { type: 'Order', id: `${orderId}/search` };
}

/**
 * `GET /orders/:id/search` (issue #398, ADR-0055 § 5): the radar's round,
 * ring, count and coarse cells while the order searches.
 *
 * **`keepUnusedDataFor: 0`**: the cells are a derivative of masters'
 * positions, and leaving the screen — or the order leaving `SEARCHING`, which
 * unsubscribes — drops them from the store at once, as the tracking card's
 * position is dropped (`tracking-endpoints.ts`, CLAUDE.md § 11).
 *
 * Read on mount, on every `order:search-wave` and after a reconnect. Never
 * polled: the server knows exactly when something changes, once per wave.
 */
export const orderSearchApi = api.injectEndpoints({
  endpoints: (build) => ({
    orderSearch: build.query<OrderSearchProgress, string>({
      query: (orderId) => `/orders/${orderId}/search`,
      providesTags: (_result, _error, orderId) => [orderSearchTag(orderId)],
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useOrderSearchQuery } = orderSearchApi;
