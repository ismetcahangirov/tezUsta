import { describe, expect, it } from 'vitest';

import {
  CATEGORY_POLICY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  categoryOfKind,
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
});
