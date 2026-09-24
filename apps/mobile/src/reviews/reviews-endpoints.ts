import type {
  CursorPage,
  OrderReviews,
  Review,
  ReviewAuthorRole,
  SubmitReviewRequest,
} from '@tezusta/types';

import { api } from '../api/api-slice';

/** The body of a submit or an edit, and the order it is about. */
export interface SubmitReviewArg extends SubmitReviewRequest {
  readonly orderId: string;
}

/**
 * The reviews on one order, injected by the feature that owns them (issue #227,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **One tag per order, `{ type: 'Review', id: orderId }`.** The prompt card on
 * the order screen, the one on the master's job screen and home, and the review
 * screen itself all read the same entry — so a submit that invalidates it hides
 * every prompt for that order in the same render, wherever it is on the stack.
 *
 * **Invalidated on failure too.** Every refusal the server can give a party —
 * the window closed, the review already written, already revealed, the order
 * no longer reviewable — means what the screen showed was no longer true, and
 * the next read is what tells the screen which state it is really in. A
 * transport failure changed nothing, but re-reading after one costs a request
 * and cannot show anything wrong.
 *
 * **No optimistic patch.** Whether a review is sealed or revealed is the
 * server's decision — the second review reveals both in one transaction — and
 * the client cannot know which of the two its own submit will be.
 */
export const reviewsApi = api.injectEndpoints({
  endpoints: (build) => ({
    orderReviews: build.query<OrderReviews, string>({
      query: (orderId) => `/orders/${orderId}/reviews`,
      providesTags: (_result, _error, orderId) => [{ type: 'Review', id: orderId }],
    }),

    /**
     * Writes the caller's review. The author's side is never sent — the server
     * derives it from who is asking.
     *
     * On success the order and the job are invalidated as well (issue #227):
     * nothing on either changes today, but they are what the prompt sits on,
     * and a later field that did change (a "reviewed" mark, a rating) must not
     * depend on somebody remembering to add it here.
     */
    submitReview: build.mutation<Review, SubmitReviewArg>({
      query: ({ orderId, rating, comment }) => ({
        url: `/orders/${orderId}/review`,
        method: 'POST',
        body: { rating, comment: comment ?? null },
      }),
      invalidatesTags: (_result, error, { orderId }) =>
        error === undefined
          ? [
              { type: 'Review', id: orderId },
              // A second review reveals both: the other side's may now be readable.
              { type: 'Review', id: 'RECEIVED' },
              { type: 'Order', id: orderId },
              'MasterJob',
            ]
          : [{ type: 'Review', id: orderId }],
    }),

    /**
     * Reviews written about the caller in one role, newest first (issue #228,
     * `GET /me/reviews/received`). The server returns revealed, unremoved
     * reviews only.
     *
     * **An infinite query, for the reason `customerOrders` is one**: the pages
     * it holds are refetched together, and the cursor is the server's, opaque
     * and never built here. `null` first page param, because `undefined` from
     * `getNextPageParam` is RTK Query's "no more pages".
     *
     * The role is the argument, so a person who is both customer and master
     * has two entries that can never be mixed.
     */
    receivedReviews: build.infiniteQuery<CursorPage<Review>, ReviewAuthorRole, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/me/reviews/received',
        params: pageParam === null ? { role: queryArg } : { role: queryArg, cursor: pageParam },
      }),
      providesTags: [{ type: 'Review', id: 'RECEIVED' }],
    }),

    /** Replaces the caller's sealed review. The body is the whole review. */
    editReview: build.mutation<Review, SubmitReviewArg>({
      query: ({ orderId, rating, comment }) => ({
        url: `/orders/${orderId}/review`,
        method: 'PUT',
        body: { rating, comment: comment ?? null },
      }),
      invalidatesTags: (_result, _error, { orderId }) => [{ type: 'Review', id: orderId }],
    }),
  }),
});

export const {
  useOrderReviewsQuery,
  useReceivedReviewsInfiniteQuery,
  useSubmitReviewMutation,
  useEditReviewMutation,
} = reviewsApi;
