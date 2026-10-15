import type { AdminPortfolioEvidence } from '@tezusta/types';

import type { PortfolioStatusFilter } from './api';

/** Portfolio moderation strings. English placeholder copy, like the rest of the panel. */
export const portfolioCopy = {
  intro:
    'Every portfolio post, removed and deleted ones included. Removing a post hides it at once; its photos are kept privately as evidence for the retention window, then deleted.',
  filters: {
    title: 'Filters',
    masterId: 'Master id',
    status: 'Status',
    anyStatus: 'Any status',
    apply: 'Apply filters',
    clear: 'Clear',
    invalidId: 'Paste a full id (a UUID).',
  },
  status: {
    draft: 'Draft',
    processing: 'Processing',
    published: 'Published',
    failed: 'Failed',
    deleted: 'Deleted by the master',
    removed: 'Removed',
  } satisfies Record<PortfolioStatusFilter, string>,
  evidence: {
    none: '',
    pending_move: 'Photos still being moved to private storage',
    kept: 'Photos kept privately as evidence',
    purged: 'Photos deleted after the retention window',
  } satisfies Record<AdminPortfolioEvidence, string>,

  table: {
    caption: 'Portfolio posts',
    created: 'Created',
    master: 'Master',
    status: 'Status',
    photos: 'Photos',
    caption_: 'Caption',
    open: 'Open',
    noCaption: 'No caption',
  },

  loading: 'Loading posts…',
  loadFailed: 'Posts could not be loaded.',
  retry: 'Try again',
  empty: 'No posts match these filters.',
  loadMore: 'Load more',
  loadingMore: 'Loading…',

  detail: {
    back: 'Portfolio',
    title: 'Portfolio post',
    notFound: 'There is no such post.',
    loadFailed: 'The post could not be loaded.',
    master: 'Master',
    created: 'Created',
    published: 'Published',
    caption: 'Caption',
    photos: 'Photos',
    noPhotos: 'No photos to show.',
    photoAlt: (position: number) => `Photo ${String(position + 1)}`,
    removedAt: 'Removed',
    removalReason: 'Reason',
    remove: 'Remove post',
    removed: 'The post was removed.',
    alreadyRemoved: 'Another admin had already removed this post.',
    openFailed: 'The photo could not be opened. Try again.',
  },

  removal: {
    title: 'Remove this post',
    reason: 'Reason',
    hint: 'Kept in the audit log; the master sees only that the post was removed. Required, up to 600 characters.',
    reasonEmpty: 'Give a reason for the removal.',
    reasonTooLong: 'At most 600 characters.',
    confirm: 'Remove post',
    confirming: 'Removing…',
    cancel: 'Cancel',
    failed: 'The post was not removed. Try again.',
  },

  avatar: {
    title: 'Avatar',
    none: 'No avatar.',
    alt: (name: string) => `${name}'s avatar`,
    remove: 'Remove avatar',
    removed: 'The avatar was removed.',
    posts: 'Portfolio posts',
    dialogTitle: 'Remove this avatar',
    hint: 'Kept in the audit log. The photo is deleted at once. Required, up to 600 characters.',
    confirm: 'Remove avatar',
    failed: 'The avatar was not removed. Try again.',
  },
};
