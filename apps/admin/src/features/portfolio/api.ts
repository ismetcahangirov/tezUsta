import type { AdminPortfolioPost, AdminPortfolioPostDetail, CursorPage } from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export type PortfolioStatusFilter =
  'draft' | 'processing' | 'published' | 'failed' | 'deleted' | 'removed';

/** The filters `GET /admin/portfolio/posts` accepts; each optional, combined with AND. */
export interface PortfolioFilters {
  readonly masterId?: string;
  readonly status?: PortfolioStatusFilter;
}

/** The API's own default page size, stated so a test can see it. */
export const PORTFOLIO_PAGE_SIZE = 50;

/**
 * Portfolio moderation (#312, `portfolio.moderate`). A removal re-reads the
 * list and the post through the `Portfolio` tag; an avatar removal re-reads
 * the master's file through the masters API's `Master` tag.
 */
export const portfolioApi = adminApi
  .enhanceEndpoints({ addTagTypes: ['Portfolio', 'Master'] })
  .injectEndpoints({
    endpoints: (build) => ({
      portfolioPosts: build.infiniteQuery<
        CursorPage<AdminPortfolioPost>,
        PortfolioFilters,
        string | null
      >({
        infiniteQueryOptions: {
          initialPageParam: null,
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
        query: ({ queryArg, pageParam }) => ({
          url: '/admin/portfolio/posts',
          params: {
            ...queryArg,
            limit: PORTFOLIO_PAGE_SIZE,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
        }),
        providesTags: ['Portfolio'],
      }),
      portfolioPost: build.query<AdminPortfolioPostDetail, string>({
        query: (postId) => `/admin/portfolio/posts/${encodeURIComponent(postId)}`,
        providesTags: ['Portfolio'],
      }),
      removePortfolioPost: build.mutation<
        AdminPortfolioPostDetail,
        { readonly id: string; readonly reason: string }
      >({
        query: ({ id, reason }) => ({
          url: `/admin/portfolio/posts/${encodeURIComponent(id)}/removal`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: ['Portfolio'],
      }),
      removeMasterAvatar: build.mutation<
        void,
        { readonly masterId: string; readonly reason: string }
      >({
        query: ({ masterId, reason }) => ({
          url: `/admin/masters/${encodeURIComponent(masterId)}/avatar/removal`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: (_result, _error, { masterId }) => [{ type: 'Master', id: masterId }],
      }),
    }),
  });

export const {
  usePortfolioPostsInfiniteQuery,
  usePortfolioPostQuery,
  useRemovePortfolioPostMutation,
  useRemoveMasterAvatarMutation,
} = portfolioApi;
