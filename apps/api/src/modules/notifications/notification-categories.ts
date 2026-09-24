import type {
  NotificationCategory,
  NotificationChannelId,
  NotificationPreference,
} from '@tezusta/types';

import type { NotificationKind } from './notification.types';

export type { NotificationCategory, NotificationChannelId } from '@tezusta/types';
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
  'messages',
  'calls',
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
  'message-received': 'messages',
  'call-incoming': 'calls',
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
    /**
     * **Transactional, like the outcomes above, and deliberately not like
     * `order-progress`** (#180). A message is somebody on a live job saying
     * something the other person needs — "the entrance is round the back",
     * "I am at the door" — and the push is only raised for one that went
     * unread. A user who silenced it would not have a quieter app; they would
     * have a master standing outside a locked door. The rule is a flag, so
     * relaxing it later is the one-line change the note on `changeable`
     * describes.
     */
    messages: { changeable: false, defaultEnabled: true },
    /**
     * **Transactional, and the least switchable of them all** (#189,
     * ADR-0039). The push is how a phone whose app is not open learns that
     * somebody on a live job is ringing it right now; a user who silenced it
     * would not get fewer calls, they would get calls that ring out unheard
     * while the caller waits. It is also bounded by construction — raised
     * only by an invite, which is rate-limited per order, and dropped by the
     * worker once the call stops ringing.
     */
    calls: { changeable: false, defaultEnabled: true },
  });

/**
 * The channel a push lands in when the app has no channel for its category.
 *
 * **Not a guess and not a spare — it is the channel the manifest names.** The
 * `expo-notifications` plugin writes `defaultChannel` into
 * `com.google.firebase.messaging.default_notification_channel_id`
 * (`apps/mobile/app.config.js`), and FCM delivers into it whenever the message
 * names a channel the device has not created. Sending this id explicitly is
 * therefore the same delivery as sending none, said out loud.
 */
export const DEFAULT_NOTIFICATION_CHANNEL_ID: NotificationChannelId = 'default';

/**
 * Which Android channel each category is delivered on.
 *
 * **The identity mapping, written out rather than assumed.** Every id below
 * equals its category's name today, and the map is still here because the two
 * are different kinds of thing with different lifetimes: a category is a
 * product vocabulary this repository may rename, and a channel id is frozen
 * into every phone that has ever created it. Android fixes a channel's
 * importance, sound and vibration at creation and offers no way to change them
 * afterwards — a new id is the only way, and it orphans the old channel in the
 * user's settings list rather than replacing it. The map is the seam that keeps
 * one of those renames from forcing the other.
 *
 * Total over {@link NotificationCategory}, so a category added without a
 * channel does not compile — the alternative being a notification that is
 * delivered, quietly, into whatever channel Android chose.
 */
const CHANNEL_OF_CATEGORY: Readonly<Record<NotificationCategory, NotificationChannelId>> =
  Object.freeze({
    'order-offers': 'order-offers',
    'order-accepted': 'order-accepted',
    'order-progress': 'order-progress',
    'order-cancelled': 'order-cancelled',
    'order-no-master-found': 'order-no-master-found',
    messages: 'messages',
    /**
     * The one channel the app creates at maximum importance, with a vibration
     * pattern (`apps/mobile/src/notifications/notification-channels.ts`) — a
     * ring has to be heard through a pocket, which no other category does.
     */
    calls: 'calls',
  });

/**
 * The channel id for a category, falling back to the default.
 *
 * The `??` is a **runtime** backstop under a type the compiler believes is
 * total, and it earns its place: a category reaches this function from a job
 * payload, which crossed Redis and a deploy boundary. A category this release
 * cannot map is delivered into the default channel — audible, in the tray, one
 * channel too coarse — rather than being addressed to a channel that exists
 * nowhere.
 */
export function channelIdOfCategory(category: NotificationCategory): NotificationChannelId {
  return CHANNEL_OF_CATEGORY[category] ?? DEFAULT_NOTIFICATION_CHANNEL_ID;
}

/**
 * The channel one notification kind is delivered on.
 *
 * **Keyed through the category, never off the kind.** Several kinds share a
 * category on purpose — the four progress steps are one switch, and
 * `order-redispatched` shares the cancellation switch — and a channel per kind
 * would put nine entries in the phone's own settings screen where five is
 * already as many as a person will read. The channel and the preference switch
 * being the same unit is also what makes them explicable: the line a user turns
 * off in Android settings is the line they turn off in ours.
 */
export function channelIdOfKind(kind: NotificationKind): NotificationChannelId {
  return channelIdOfCategory(categoryOfKind(kind));
}

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
