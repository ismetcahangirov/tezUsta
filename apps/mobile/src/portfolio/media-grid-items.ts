import type { PortfolioPost } from '@tezusta/types';

/**
 * One tile of the grid (ADR-0054 § 2 and § 5).
 *
 * A reader of someone else's profile only ever sees `published` tiles. The
 * master's own grid also shows a post that is still `processing` and one that
 * `failed`; mapping their own posts to tiles is the editor's (#314), which owns
 * that data.
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
