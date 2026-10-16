import type { MasterPublicProfile, PortfolioMedia, PortfolioPost } from '@tezusta/types';

import type { MediaGridItem } from './media-grid-items';

/**
 * Posts and profiles for the portfolio's stories and tests (issue #313): one
 * photo, many photos, a long caption, a photo that will not load, and none.
 *
 * The URLs are placeholders on a reserved domain (RFC 2606), so nothing here
 * reaches a real bucket; in Storybook they fail to load, which is the
 * fallback's own story. The two data URIs do load: tiny placeholder images,
 * landscape and portrait, split diagonally so a crop and a whole photo look
 * different. They stand in for a photo; they are not design values.
 */

/** 8 x 6 px greyscale PNG. */
export const LANDSCAPE_PHOTO_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAAAAADbboAnAAAAHUlEQVR4nGOYCQUMUDoUygiFMEJDIYxQKANMhwIAwqAX6XJVuwUAAAAASUVORK5CYII=';

/** 6 x 8 px greyscale PNG. */
export const PORTRAIT_PHOTO_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAYAAAAICAAAAAD/rdHkAAAAG0lEQVR4nGOYCQYMyFQomAoFU6HIVCiYApGhAN0yF+n0/Wn1AAAAAElFTkSuQmCC';

/** A URL that never loads. */
export const BROKEN_PHOTO_URL = 'https://media.example.invalid/broken.webp';

export function media(id: string, url?: string): PortfolioMedia {
  return {
    id,
    thumbUrl: url ?? `https://media.example.com/${id}-thumb.webp`,
    displayUrl: url ?? `https://media.example.com/${id}-display.webp`,
    width: 1440,
    height: 1080,
  };
}

export const ONE_PHOTO_POST: PortfolioPost = {
  id: 'post-one',
  caption: 'Mətbəx kranının dəyişdirilməsi',
  service: { serviceId: 'svc-plumbing', name: 'Santexnik' },
  media: [media('one-1')],
};

export const MANY_PHOTOS_POST: PortfolioPost = {
  id: 'post-many',
  caption: 'Hamamın tam təmiri: əvvəl və sonra',
  service: { serviceId: 'svc-plumbing', name: 'Santexnik' },
  media: [media('many-1'), media('many-2'), media('many-3'), media('many-4'), media('many-5')],
};

export const LONG_CAPTION_POST: PortfolioPost = {
  id: 'post-long',
  caption: Array.from(
    { length: 12 },
    () =>
      'Köhnə borular çıxarıldı, yeni plastik borular çəkildi, bütün birləşmələr yoxlanıldı və təzyiq altında sınaqdan keçirildi.',
  ).join(' '),
  service: null,
  media: [media('long-1'), media('long-2')],
};

export const NO_CAPTION_POST: PortfolioPost = {
  id: 'post-bare',
  caption: null,
  service: null,
  media: [media('bare-1')],
};

export const BROKEN_PHOTO_POST: PortfolioPost = {
  id: 'post-broken',
  caption: 'Şəkil açılmayan paylaşım',
  service: null,
  media: [media('broken-1', BROKEN_PHOTO_URL)],
};

/** Points every photo of `post` at a placeholder that loads, alternating landscape and portrait. */
export function withLoadingPhotos(post: PortfolioPost): PortfolioPost {
  return {
    ...post,
    media: post.media.map((item, i) =>
      media(item.id, i % 2 === 0 ? LANDSCAPE_PHOTO_URL : PORTRAIT_PHOTO_URL),
    ),
  };
}

/** `count` published tiles, alternating one photo and three, newest first. */
export function publishedTiles(
  count: number,
  url?: string,
): Extract<MediaGridItem, { kind: 'published' }>[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'published' as const,
    postId: `post-${String(i + 1)}`,
    thumbUrl: url ?? `https://media.example.com/post-${String(i + 1)}-thumb.webp`,
    photoCount: i % 2 === 0 ? 1 : 3,
    caption: i % 3 === 0 ? null : `Paylaşım ${String(i + 1)}`,
  }));
}

export const PROFILE: MasterPublicProfile = {
  masterId: 'master-1',
  displayName: 'Elvin Məmmədov',
  bio: 'On ildir santexnika və istilik sistemləri ilə işləyirəm. Bakının bütün rayonlarına gəlirəm.',
  avatarUrl: null,
  avatarLargeUrl: null,
  rating: { ratingAverage: 4.67, ratingCount: 12 },
  services: [
    { serviceId: 'svc-plumbing', name: 'Santexnik', priceMinor: 2500 },
    { serviceId: 'svc-heating', name: 'Kombi təmiri', priceMinor: null },
  ],
  posts: [ONE_PHOTO_POST, MANY_PHOTOS_POST],
  nextCursor: null,
};

export const LONG_BIO =
  'On ildir santexnika və istilik sistemləri ilə işləyirəm. Kombi quraşdırılması, boru xətlərinin dəyişdirilməsi, sızmaların tapılması və aradan qaldırılması, hamam və mətbəx təmiri ilə məşğulam. Bakının bütün rayonlarına, həmçinin Sumqayıt və Abşerona gəlirəm. İş bitdikdən sonra yerləri təmiz qoyuram və gördüyüm işə zəmanət verirəm. Material lazım olsa, əvvəlcədən qiymətini deyirəm.';
