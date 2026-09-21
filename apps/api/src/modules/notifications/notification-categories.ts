import type { NotificationCategory, NotificationPreference } from '@tezusta/types';

import type { NotificationKind } from './notification.types';

export type { NotificationCategory } from '@tezusta/types';
export { NOTIFICATION_KINDS } from './notification.types';

/**
 * Every category, in the order a settings screen would read them.
 *
 * Derived from nothing: this is the list, and {@link CATEGORY_POLICY} below is
 * keyed by it so a member added to the union without a policy does not
 * compile. The union itself lives in `@tezusta/types` because it crosses HTTP
 * — `apps/mobile` renders these (#147) and a second copy would drift.
 */
export const NOTIFICATION_CATEGORIES = Object.freeze([
  'order-offers',
  'order-accepted',
  'order-progress',
  'order-cancelled',
  'order-no-master-found',
] as const satisfies readonly NotificationCategory[]);

/**
 * Which switch each notification kind sits behind.
 *
 * **Several kinds may share a category and that is the point.** The four
 * master-driven progress steps are one line in a settings screen, not four,
 * so the client's vocabulary is coarser than the server's on purpose.
 *
 * Typed as a total record over {@link NotificationKind}, the same guarantee
 * `notification-copy.ts` gets for its copy table: adding a kind without
 * deciding which switch it answers to is a compile error rather than a
 * notification nobody can turn off.
 */
const CATEGORY_OF_KIND: Readonly<Record<NotificationKind, NotificationCategory>> = Object.freeze({
  'order-offer': 'order-offers',
  'order-accepted': 'order-accepted',
  'order-status-changed': 'order-progress',
  'order-cancelled': 'order-cancelled',
  /**
   * Shares the cancellation switch rather than getting one of its own.
   *
   * A category is a switch a person sees, and both of these say the same
   * thing to the person reading them: **the master you had is gone**. They
   * differ in what happens next, which is what the copy is for, not what a
   * settings toggle is for. Both are transactional and therefore always on,
   * so a separate category would be a second permanently-enabled switch
   * nobody can act on — and `notification_preferences` needs no backfill, so
   * splitting them later stays a cheap, additive change if the owner ever
   * wants the distinction.
   */
  'order-redispatched': 'order-cancelled',
  'order-no-master-found': 'order-no-master-found',
});

/** What a category is worth to a user who has never opened settings. */
export interface CategoryPolicy {
  /**
   * Whether a user may switch it off.
   *
   * `false` marks a **transactional** category: it reports the outcome of
   * something the user themselves asked for. A master who silenced offers is
   * not supply and will be dispatched to anyway; a customer who silenced "a
   * master took your job" experiences the product as broken rather than quiet.
   *
   * **This is a product rule stated as an assumption** (issue #143's open
   * question to the owner), and it is a flag here rather than a hardcoded list
   * in the client precisely so that relaxing it later is a one-line server
   * change with no migration and no app release.
   */
  readonly changeable: boolean;
  /**
   * What a user gets before they express a preference.
   *
   * Per category rather than one global constant, so the first opt-in category
   * — a promotion, a digest — is a row in this table rather than a change to
   * how defaults work.
   */
  readonly defaultEnabled: boolean;
}

/**
 * The rule per category.
 *
 * `order-progress` is the only changeable one, and the asymmetry is
 * deliberate. `order-accepted` and `order-no-master-found` are **the two
 * possible outcomes of the same wait**: a customer who is told when the search
 * succeeds but not when it fails is left in the worse of the two silences, so
 * locking one and not the other would be incoherent. `order-progress` is a
 * stream rather than an outcome — on the way, arrived, started, finished — and
 * a customer who does not want four pushes per job can reasonably open the app
 * instead.
 */
export const CATEGORY_POLICY: Readonly<Record<NotificationCategory, CategoryPolicy>> =
  Object.freeze({
    'order-offers': { changeable: false, defaultEnabled: true },
    'order-accepted': { changeable: false, defaultEnabled: true },
    'order-progress': { changeable: true, defaultEnabled: true },
    'order-cancelled': { changeable: false, defaultEnabled: true },
    'order-no-master-found': { changeable: false, defaultEnabled: true },
  });

/**
 * What a user has actually stored, keyed by category.
 *
 * A map rather than an array because every read below is a lookup, and
 * **absence is meaningful**: no entry means the user has never expressed a
 * preference for that category, which is not the same as having switched it
 * on. Keeping the two distinct is what lets a new category ship with a default
 * and no backfill.
 */
export type StoredPreferences = ReadonlyMap<NotificationCategory, boolean>;

/** Which switch this kind answers to. */
export function categoryOfKind(kind: NotificationKind): NotificationCategory {
  return CATEGORY_OF_KIND[kind];
}

/** Whether a user may switch this category off. */
export function isCategoryChangeable(category: NotificationCategory): boolean {
  return CATEGORY_POLICY[category].changeable;
}

/**
 * Whether this user currently receives this category.
 *
 * **The policy outranks the stored row, and that is not belt-and-braces.** A
 * row can outlive the rule that allowed it: a category switched off while it
 * was changeable keeps its `false` after the rule tightens, and reading the
 * row first would leave the new rule holding only for users who arrived after
 * it. Deleting such rows on deploy is the other option and is worse — it
 * destroys the preference the user expressed, so relaxing the rule again could
 * not restore it.
 */
export function isCategoryEnabled(
  category: NotificationCategory,
  stored: StoredPreferences,
): boolean {
  const policy = CATEGORY_POLICY[category];
  if (!policy.changeable) {
    return policy.defaultEnabled;
  }
  return stored.get(category) ?? policy.defaultEnabled;
}

/**
 * Every category with its current value — what `GET /notification-preferences`
 * answers.
 *
 * Returns the whole set rather than the stored rows, because a settings screen
 * renders every switch and a client should never have to know which ones are
 * missing or what a missing one means.
 */
export function resolvePreferences(stored: StoredPreferences): NotificationPreference[] {
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    enabled: isCategoryEnabled(category, stored),
    changeable: CATEGORY_POLICY[category].changeable,
  }));
}

/** Whether a kind is one this user still wants. The worker's whole question. */
export function isKindEnabled(kind: NotificationKind, stored: StoredPreferences): boolean {
  return isCategoryEnabled(categoryOfKind(kind), stored);
}
