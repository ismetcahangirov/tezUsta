import type { OwnPortfolioPost } from '@tezusta/types';

import { gridItemsFromOwnPosts, gridItemsFromPosts, viewablePost } from './media-grid-items';
import { MANY_PHOTOS_POST, NO_CAPTION_POST, ONE_PHOTO_POST } from './portfolio-fixtures';

describe('gridItemsFromPosts', () => {
  it('makes one tile per post, in the order the server sent, from its first photo', () => {
    expect(gridItemsFromPosts([MANY_PHOTOS_POST, ONE_PHOTO_POST, NO_CAPTION_POST])).toEqual([
      {
        kind: 'published',
        postId: MANY_PHOTOS_POST.id,
        thumbUrl: MANY_PHOTOS_POST.media[0]!.thumbUrl,
        photoCount: 5,
        caption: MANY_PHOTOS_POST.caption,
      },
      {
        kind: 'published',
        postId: ONE_PHOTO_POST.id,
        thumbUrl: ONE_PHOTO_POST.media[0]!.thumbUrl,
        photoCount: 1,
        caption: ONE_PHOTO_POST.caption,
      },
      {
        kind: 'published',
        postId: NO_CAPTION_POST.id,
        thumbUrl: NO_CAPTION_POST.media[0]!.thumbUrl,
        photoCount: 1,
        caption: null,
      },
    ]);
  });

  it('leaves out a post with no photo rather than drawing an empty tile', () => {
    expect(gridItemsFromPosts([{ ...ONE_PHOTO_POST, media: [] }])).toEqual([]);
  });
});

function own(
  id: string,
  status: OwnPortfolioPost['status'],
  overrides: Partial<OwnPortfolioPost> = {},
): OwnPortfolioPost {
  const ready = status === 'published';
  return {
    id,
    status,
    caption: null,
    service: null,
    media: [
      {
        id: `${id}-m`,
        position: 0,
        status: ready ? 'ready' : 'processing',
        failureCode: null,
        thumbUrl: ready ? `https://media.example.com/${id}-thumb.webp` : null,
        displayUrl: ready ? `https://media.example.com/${id}-display.webp` : null,
        width: ready ? 1440 : null,
        height: ready ? 1080 : null,
      },
    ],
    failureCode: null,
    removedAt: null,
    createdAt: '2026-10-16T08:00:00.000Z',
    publishedAt: null,
    ...overrides,
  };
}

describe('gridItemsFromOwnPosts', () => {
  it('marks processing and failed posts, and draws published ones from their ready photo', () => {
    expect(
      gridItemsFromOwnPosts([own('a', 'processing'), own('b', 'failed'), own('c', 'published')]),
    ).toEqual([
      { kind: 'processing', postId: 'a' },
      { kind: 'failed', postId: 'b' },
      {
        kind: 'published',
        postId: 'c',
        thumbUrl: 'https://media.example.com/c-thumb.webp',
        photoCount: 1,
        caption: null,
      },
    ]);
  });

  it('leaves out drafts and posts an admin removed', () => {
    expect(
      gridItemsFromOwnPosts([
        own('a', 'draft'),
        own('b', 'published', { removedAt: '2026-10-16T09:00:00.000Z' }),
      ]),
    ).toEqual([]);
  });

  it('shows the viewer only the ready photos of a post', () => {
    expect(viewablePost(own('a', 'processing'))).toBeNull();
    expect(viewablePost(own('b', 'published'))?.media.map((media) => media.id)).toEqual(['b-m']);
  });
});
