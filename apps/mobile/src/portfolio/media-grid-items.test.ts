import { gridItemsFromPosts } from './media-grid-items';
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
