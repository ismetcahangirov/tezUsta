import type {
  AdminReview,
  CursorPage,
  RatingRecalculation,
  RecalculateRatingsRequest,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

/** The filters `GET /admin/reviews` accepts; each optional, combined with AND. */
export interface ReviewFilters {
  readonly orderId?: string;
  readonly masterId?: string;
  readonly customerId?: string;
}

/** The API's own default page size, stated so a test can see it. */
export const REVIEWS_PAGE_SIZE = 50;

/**
 * Review moderation (EPIC 11 API, `reviews.moderate`). The list is an
 * infinite query over the API's cursor: each "Load more" appends one page,
 * and a removal re-reads every page loaded so far through the `Reviews` tag.
 */
export const reviewsApi = adminApi.enhanceEndpoints({ addTagTypes: ['Reviews'] }).injectEndpoints({
  endpoints: (build) => ({
    reviews: build.infiniteQuery<CursorPage<AdminReview>, ReviewFilters, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/admin/reviews',
        params: {
          ...queryArg,
          limit: REVIEWS_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      }),
      providesTags: ['Reviews'],
    }),
    removeReview: build.mutation<AdminReview, { readonly id: string; readonly reason: string }>({
      query: ({ id, reason }) => ({
        url: `/admin/reviews/${encodeURIComponent(id)}/removal`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: ['Reviews'],
    }),
    recalculateRatings: build.mutation<RatingRecalculation, RecalculateRatingsRequest>({
      query: (body) => ({ url: '/admin/ratings/recalculate', method: 'POST', body }),
    }),
  }),
});

export const { useReviewsInfiniteQuery, useRemoveReviewMutation, useRecalculateRatingsMutation } =
  reviewsApi;
