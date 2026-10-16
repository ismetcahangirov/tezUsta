import type { OwnPortfolioPost, PortfolioMedia, PortfolioPost } from '@tezusta/types';

/**
 * One tile of the grid (ADR-0054 § 2 and § 5).
 *
 * A reader of someone else's profile only ever sees `published` tiles. The
 * master's own grid also shows a post that is still `processing` and one that
 * `failed`: `gridItemsFromOwnPosts` maps those (#314).
 */
export type MediaGridItem =
  | {
      readonly kind: 'published';
      readonly postId: string;
      /** The first photo's `thumb` rendition: never a full-size upload in a list. */
      readonly thumbUrl: string;
      readonly photoCount: number;
      readonly caption: string | null;
    }
  | { readonly kind: 'processing'; readonly postId: string }
  | { readonly kind: 'failed'; readonly postId: string };

/**
 * The tiles for a profile's posts, in the order the server sent them (newest
 * first, ADR-0045 § 3). A post with no photo has nothing to show and is left
 * out; the server never sends one, so this only keeps a bad page from drawing
 * an empty tile.
 */
export function gridItemsFromPosts(posts: readonly PortfolioPost[]): MediaGridItem[] {
  return posts.flatMap((post): MediaGridItem[] => {
    const first = post.media[0];
    if (first === undefined) {
      return [];
    }

    return [
      {
        kind: 'published',
        postId: post.id,
        thumbUrl: first.thumbUrl,
        photoCount: post.media.length,
        caption: post.caption,
      },
    ];
  });
}

/**
 * The master's own grid (ADR-0054 § 5): published posts as photos, and the
 * ones still processing or that failed as their own tiles, newest first.
 *
 * **Left out**: drafts, which are the editor's and not yet a post, and posts an
 * admin removed (ADR-0045 § 6), which stay out of the profile.
 */
export function gridItemsFromOwnPosts(posts: readonly OwnPortfolioPost[]): MediaGridItem[] {
  return posts.flatMap((post): MediaGridItem[] => {
    if (post.removedAt !== null) {
      return [];
    }
    switch (post.status) {
      case 'draft':
        return [];
      case 'processing':
        return [{ kind: 'processing', postId: post.id }];
      case 'failed':
        return [{ kind: 'failed', postId: post.id }];
      case 'published': {
        const viewable = viewablePost(post);
        return viewable === null ? [] : gridItemsFromPosts([viewable]);
      }
    }
  });
}

/**
 * An own published post as the viewer shows it: its ready photos, in order.
 * Null for a post with none ready, which the server does not publish.
 */
export function viewablePost(post: OwnPortfolioPost): PortfolioPost | null {
  const media = post.media.flatMap((item): PortfolioMedia[] =>
    item.status === 'ready' &&
    item.thumbUrl !== null &&
    item.displayUrl !== null &&
    item.width !== null &&
    item.height !== null
      ? [
          {
            id: item.id,
            thumbUrl: item.thumbUrl,
            displayUrl: item.displayUrl,
            width: item.width,
            height: item.height,
          },
        ]
      : [],
  );
  return media.length === 0
    ? null
    : { id: post.id, caption: post.caption, service: post.service, media };
}
