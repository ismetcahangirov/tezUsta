import { describe, expect, it } from 'vitest';

import {
  CATEGORY_POLICY,
  DEFAULT_NOTIFICATION_CHANNEL_ID,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  categoryOfKind,
  channelIdOfCategory,
  channelIdOfKind,
  isCategoryChangeable,
  isCategoryEnabled,
  resolvePreferences,
} from './notification-categories';
import type { NotificationCategory } from './notification-categories';

/**
 * The category vocabulary and the rules that hang off it (issue #143).
 *
 * These are pure functions over two closed sets, so a unit test is the right
 * layer: what needs proving is that the mapping is total, that the defaults
 * are the ones a user who has never opened settings gets, and that a stored
 * row overrides exactly one category. Whether the filter actually runs before
 * a push leaves is a property of the worker, and is proved against real
 * Postgres and Redis in `test/notification-preferences.delivery.e2e.test.ts`.
 */
describe('notification categories', () => {
  it('gives every notification kind a category', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_CATEGORIES).toContain(categoryOfKind(kind));
    }
  });

  it('gives every category a policy', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(CATEGORY_POLICY[category]).toBeDefined();
    }
  });

  /**
   * The product rule this issue implements as an assumption, recorded as a
   * test so that changing it is a deliberate edit rather than a side effect.
   * Each of these reports the outcome of something the user themselves asked
   * for; silencing one makes the product look broken rather than quiet.
   */
  it.each<NotificationCategory>([
    'order-offers',
    'order-accepted',
    'order-cancelled',
    'order-no-master-found',
  ])('refuses to let %s be switched off', (category) => {
    expect(isCategoryChangeable(category)).toBe(false);
  });

  /**
   * The one genuinely optional category: a progress stream rather than an
   * outcome. A customer who does not want four pushes per job can switch it
   * off and open the app instead.
   */
  it('lets the progress stream be switched off', () => {
    expect(isCategoryChangeable('order-progress')).toBe(true);
  });

  it('gives a user who has stored nothing every category, all on', () => {
    const resolved = resolvePreferences(new Map());

    expect(resolved).toHaveLength(NOTIFICATION_CATEGORIES.length);
    expect(resolved.every((preference) => preference.enabled)).toBe(true);
    expect(resolved.map((preference) => preference.category).sort()).toEqual(
      [...NOTIFICATION_CATEGORIES].sort(),
    );
  });

  it('reports whether each category may be changed', () => {
    const resolved = resolvePreferences(new Map());
    const progress = resolved.find((preference) => preference.category === 'order-progress');
    const offers = resolved.find((preference) => preference.category === 'order-offers');

    expect(progress?.changeable).toBe(true);
    expect(offers?.changeable).toBe(false);
  });

  it('applies a stored preference and leaves every other category alone', () => {
    const resolved = resolvePreferences(new Map([['order-progress', false]]));

    const progress = resolved.find((preference) => preference.category === 'order-progress');
    const others = resolved.filter((preference) => preference.category !== 'order-progress');

    expect(progress?.enabled).toBe(false);
    expect(others.every((preference) => preference.enabled)).toBe(true);
  });

  it('treats an absent row as the default rather than as off', () => {
    expect(isCategoryEnabled('order-progress', new Map())).toBe(true);
  });

  it('honours a stored row', () => {
    expect(isCategoryEnabled('order-progress', new Map([['order-progress', false]]))).toBe(false);
    expect(isCategoryEnabled('order-progress', new Map([['order-progress', true]]))).toBe(true);
  });

  /**
   * A row stored before the rule tightened — the category was changeable when
   * the user switched it off, and is not any more. The policy wins: a stored
   * `false` on a non-changeable category must not silence it, or the rule
   * would hold only for users who arrived after it.
   */
  it('ignores a stored row that contradicts a non-changeable category', () => {
    expect(isCategoryEnabled('order-accepted', new Map([['order-accepted', false]]))).toBe(true);
  });

  /**
   * The Android channel half (issue #157).
   *
   * The ids are asserted **literally**, not derived from the category list, and
   * that is the whole value of these tests. A channel's importance is frozen on
   * the phone the first time it is created, so changing one of these strings
   * later does not re-configure a channel — it creates a second one and leaves
   * the first in the user's settings list forever. A test that computed the
   * expected id from the category would agree with any rename and warn about
   * none.
   */
  describe('android channels', () => {
    it('addresses each kind to its category’s channel', () => {
      expect(channelIdOfKind('order-offer')).toBe('order-offers');
      expect(channelIdOfKind('order-accepted')).toBe('order-accepted');
      expect(channelIdOfKind('order-status-changed')).toBe('order-progress');
      expect(channelIdOfKind('order-cancelled')).toBe('order-cancelled');
      expect(channelIdOfKind('order-no-master-found')).toBe('order-no-master-found');
    });

    /**
     * Two kinds, one channel — the same collapsing the preference switch does,
     * and for the same reason. `order-redispatched` and `order-cancelled` say
     * the same thing to the person reading them: the master you had is gone.
     * A channel of its own would be a sixth line in the phone's settings screen
     * that nobody can explain the difference of.
     */
    it('lets kinds that share a category share a channel', () => {
      expect(channelIdOfKind('order-redispatched')).toBe(channelIdOfKind('order-cancelled'));
    });

    it('gives every category a channel', () => {
      for (const category of NOTIFICATION_CATEGORIES) {
        expect(channelIdOfCategory(category)).not.toBe(DEFAULT_NOTIFICATION_CHANNEL_ID);
      }
    });

    /**
     * The backstop, exercised the only way it can be: a category this release
     * has never heard of, cast in as one that arrived from a queued job written
     * by a newer deploy. It must deliver — into the default channel, one
     * category too coarse — rather than name a channel that exists on no phone.
     */
    it('falls back to the default channel for a category it cannot map', () => {
      const unknown = 'order-reviews' as NotificationCategory;

      expect(channelIdOfCategory(unknown)).toBe(DEFAULT_NOTIFICATION_CHANNEL_ID);
    });
  });
});
