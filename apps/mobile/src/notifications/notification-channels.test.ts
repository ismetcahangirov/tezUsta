import type { NotificationCategory } from '@tezusta/types';

import { DEFAULT_CHANNEL_ID, NOTIFICATION_CHANNELS } from './notification-channels';
import { categoryCopy } from './notifications-copy';

/**
 * The channel table (issue #157).
 *
 * **These assertions are deliberately literal.** Android freezes a channel's
 * importance the first time it is created, so an id is permanent: changing one
 * of these strings does not re-configure a channel on a phone that already has
 * it, it creates a second one and leaves the first in the user's settings list
 * forever. A test that derived the expected ids from the category list would
 * agree with any rename and warn about none — which is the only failure this
 * file exists to catch, because Android itself reports nothing when a message
 * names a channel that does not exist.
 *
 * The server half — that each notification kind is addressed to the channel its
 * category maps to — is proved in
 * `apps/api/src/modules/notifications/notification-categories.test.ts` and, end
 * to end through the real worker, in
 * `apps/api/test/notification-preferences.delivery.e2e.test.ts`.
 */
describe('notification channels', () => {
  /** Every category the contract declares, restated so a rename is caught here too. */
  const CATEGORIES: readonly NotificationCategory[] = [
    'order-offers',
    'order-accepted',
    'order-progress',
    'order-cancelled',
    'order-no-master-found',
  ];

  it('creates one channel per category, plus the default', () => {
    expect(NOTIFICATION_CHANNELS.map((channel) => channel.id)).toEqual([
      DEFAULT_CHANNEL_ID,
      'order-offers',
      'order-accepted',
      'order-progress',
      'order-cancelled',
      'order-no-master-found',
    ]);
  });

  it('gives every category in the contract a channel of its own', () => {
    const ids = NOTIFICATION_CHANNELS.map((channel) => channel.id);

    for (const category of CATEGORIES) {
      expect(ids).toContain(category);
    }
  });

  /**
   * The fallback, and the reason it may not be dropped. A release that has never
   * heard of a category the server has learned receives its notifications into
   * this channel; without it they would arrive nowhere.
   */
  it('keeps the default channel, which is the one the manifest names', () => {
    const fallback = NOTIFICATION_CHANNELS.find((channel) => channel.id === DEFAULT_CHANNEL_ID);

    expect(DEFAULT_CHANNEL_ID).toBe('default');
    expect(fallback).toBeDefined();
  });

  /**
   * **The difference is the entire point of the issue.** One channel could only
   * ever be right for one of these two: a master has seconds to answer an offer,
   * and a customer does not need four banners while a job progresses.
   */
  it('alerts for an offer and stays out of the way for progress', () => {
    const levelOf = (id: string): string | undefined =>
      NOTIFICATION_CHANNELS.find((channel) => channel.id === id)?.alertLevel;

    expect(levelOf('order-offers')).toBe('heads-up');
    expect(levelOf('order-progress')).toBe('sound-only');
  });

  /**
   * Naming is the owner's (CLAUDE.md §17) and the settings screen already asks
   * the question; a channel inventing its own wording would be the same switch
   * under two names in two places.
   */
  it('names each channel with the copy its settings row already uses', () => {
    for (const category of CATEGORIES) {
      const channel = NOTIFICATION_CHANNELS.find((candidate) => candidate.id === category);

      expect(channel?.name).toBe(categoryCopy(category).title);
    }
  });

  it('names every channel, so none of them reads as an oversight in system settings', () => {
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(channel.name.trim()).not.toBe('');
    }
  });
});
