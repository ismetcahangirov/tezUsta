import type {
  CursorPage,
  MasterAvatarPresign,
  MasterAvatarUpload,
  OwnPortfolioMedia,
  OwnPortfolioPost,
  PortfolioMediaUpload,
} from '@tezusta/types';

import { api } from '../api/api-slice';

/** How many of their own posts a master's list reads at once: the server's ceiling. */
export const OWN_POSTS_PAGE_SIZE = 50;

/** The content type every photo is uploaded as: `preparePhoto` re-encodes to JPEG. */
export const UPLOAD_CONTENT_TYPE = 'image/jpeg';

export interface CreatePostArg {
  readonly caption?: string | null;
  readonly serviceId?: string | null;
}

export interface UpdatePostArg {
  readonly postId: string;
  readonly caption?: string | null;
  readonly serviceId?: string | null;
}

export interface PresignMediaArg {
  readonly postId: string;
  /** 0-based place in the post; never reused within one draft. */
  readonly position: number;
}

export interface MediaArg {
  readonly postId: string;
  readonly mediaId: string;
}

/** What a published, deleted or edited post changes besides the list. */
const PROFILE_TAGS = [{ type: 'MasterProfile' as const }] as const;

/**
 * The master's own portfolio and avatar (#308, #309, #314). Every route is the
 * caller's own: no master id is ever sent.
 *
 * **One tag, `PortfolioPost`.** The list provides it; publishing, editing and
 * deleting invalidate it, so the master's grid shows what the server now
 * holds. Creating does not: a draft is the editor's and stays out of the grid.
 * Publishing, editing and deleting also invalidate every `MasterProfile`, the
 * public view the master previews themselves through.
 *
 * **Waiting for processing is bounded, and done by the screen**
 * (`useBoundedRefresh`), never by a `pollingInterval` here: an interval that
 * outlives the screen is the uncontrolled polling CLAUDE.md §12 forbids.
 */
export const portfolioApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** Every post the master has but deleted ones, newest first. */
    ownPosts: build.infiniteQuery<CursorPage<OwnPortfolioPost>, void, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
      query: ({ pageParam }) => ({
        url: '/masters/me/portfolio/posts',
        params:
          pageParam === null
            ? { limit: OWN_POSTS_PAGE_SIZE }
            : { limit: OWN_POSTS_PAGE_SIZE, cursor: pageParam },
      }),
      providesTags: [{ type: 'PortfolioPost', id: 'LIST' }],
    }),

    /**
     * One own post, read on demand: the editor reconciles its draft with it
     * when a publish says a photo is missing. Never cached.
     */
    ownPost: build.query<OwnPortfolioPost, string>({
      query: (postId) => `/masters/me/portfolio/posts/${postId}`,
      keepUnusedDataFor: 0,
    }),

    /** A new draft. Its photos are added to it, then it is published. */
    createPost: build.mutation<OwnPortfolioPost, CreatePostArg>({
      query: (body) => ({ url: '/masters/me/portfolio/posts', method: 'POST', body }),
    }),

    /** A caption or a draft's service tag. After publishing only the caption changes (ADR-0045 § 3). */
    updatePost: build.mutation<OwnPortfolioPost, UpdatePostArg>({
      query: ({ postId, ...body }) => ({
        url: `/masters/me/portfolio/posts/${postId}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: [{ type: 'PortfolioPost', id: 'LIST' }, ...PROFILE_TAGS],
    }),

    publishPost: build.mutation<OwnPortfolioPost, string>({
      query: (postId) => ({
        url: `/masters/me/portfolio/posts/${postId}/publish`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: [{ type: 'PortfolioPost', id: 'LIST' }, ...PROFILE_TAGS],
    }),

    /**
     * Deletes a post, or abandons a draft. **Optimistic**: the post leaves the
     * master's grid at once and comes back if the server refuses (#314).
     */
    deletePost: build.mutation<void, string>({
      query: (postId) => ({ url: `/masters/me/portfolio/posts/${postId}`, method: 'DELETE' }),
      async onQueryStarted(postId, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          portfolioApi.util.updateQueryData('ownPosts', undefined, (draft) => {
            draft.pages = draft.pages.map((page) => ({
              ...page,
              items: page.items.filter((post) => post.id !== postId),
            }));
          }),
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      // On failure too: the undo restores the grid as it was when the delete
      // started, and a re-read replaces that with what the server holds now.
      invalidatesTags: (_result, error) =>
        error === undefined
          ? [{ type: 'PortfolioPost', id: 'LIST' }, ...PROFILE_TAGS]
          : [{ type: 'PortfolioPost', id: 'LIST' }],
    }),

    /** A presigned `PUT` for one photo of a draft. */
    presignMedia: build.mutation<PortfolioMediaUpload, PresignMediaArg>({
      query: ({ postId, position }) => ({
        url: `/masters/me/portfolio/posts/${postId}/media`,
        method: 'POST',
        body: { contentType: UPLOAD_CONTENT_TYPE, position },
      }),
    }),

    /** The photo is in storage: the server checks the real object and starts processing it. */
    confirmMedia: build.mutation<OwnPortfolioMedia, MediaArg>({
      query: ({ postId, mediaId }) => ({
        url: `/masters/me/portfolio/posts/${postId}/media/${mediaId}/confirm`,
        method: 'POST',
        body: {},
      }),
    }),

    /** Takes a photo out of a draft. */
    deleteMedia: build.mutation<void, MediaArg>({
      query: ({ postId, mediaId }) => ({
        url: `/masters/me/portfolio/posts/${postId}/media/${mediaId}`,
        method: 'DELETE',
      }),
    }),

    presignAvatar: build.mutation<MasterAvatarPresign, void>({
      query: () => ({
        url: '/masters/me/avatar/presign',
        method: 'POST',
        body: { contentType: UPLOAD_CONTENT_TYPE },
      }),
    }),

    confirmAvatar: build.mutation<MasterAvatarUpload, string>({
      query: (uploadId) => ({
        url: `/masters/me/avatar/${uploadId}/confirm`,
        method: 'POST',
        body: {},
      }),
    }),

    /**
     * An avatar upload's progress. Read on demand by `useAvatarUpload`, never
     * cached: each read is a fresh answer about a moving thing.
     */
    avatarUpload: build.query<MasterAvatarUpload, string>({
      query: (uploadId) => `/masters/me/avatar/${uploadId}`,
      keepUnusedDataFor: 0,
    }),

    removeAvatar: build.mutation<void, void>({
      query: () => ({ url: '/masters/me/avatar', method: 'DELETE' }),
      invalidatesTags: [{ type: 'OwnMaster', id: 'ME' }, ...PROFILE_TAGS],
    }),
  }),
});

export const {
  useOwnPostsInfiniteQuery,
  useLazyOwnPostQuery,
  useCreatePostMutation,
  useUpdatePostMutation,
  usePublishPostMutation,
  useDeletePostMutation,
  usePresignMediaMutation,
  useConfirmMediaMutation,
  useDeleteMediaMutation,
  usePresignAvatarMutation,
  useConfirmAvatarMutation,
  useLazyAvatarUploadQuery,
  useRemoveAvatarMutation,
} = portfolioApi;
