import type { NotificationCategory, NotificationChannelId } from '@tezusta/types';

import { categoryCopy, notificationsCopy } from './notifications-copy';

/**
 * The Android notification channels this app creates (issue #157).
 *
 * **A channel is the only control that survives the app.** On Android 8+ the
 * channel — not the message — carries importance, sound and vibration, and the
 * user can switch any channel off from the system settings screen whether the
 * app likes it or not. That is the whole prize here: it is the only way a master
 * keeps offers loud while silencing progress updates, and it costs nothing but
 * creating the channels.
 *
 * **It is not the same control as the server's preference switch** (#143), and
 * neither is the other's backup. A channel switched off in Android settings is
 * invisible to the server, which goes on sending — and should, because a
 * preference is a statement to TezUsta and a channel is a statement to the
 * phone. Both exist on purpose.
 *
 * **Nothing here applies to iOS**, which has no channels at all. `ensureChannels`
 * returns immediately there, and reading this file as though it described iOS
 * behaviour would be reading it wrong.
 *
 * No `expo-notifications` import: the vendor's `AndroidImportance` is an enum
 * with runtime values, and this file is imported by tests that must not load
 * that module (it throws in Expo Go on Android). {@link ChannelAlertLevel} is
 * the abstraction, and `push-adapter.ts` is the single place that turns one
 * into the vendor's number.
 */

/**
 * How loudly a channel arrives, as a decision rather than as a vendor constant.
 *
 * Three levels because there are three answers this product actually has: a
 * thing somebody is waiting on, a thing that happened, and somebody ringing.
 */
export type ChannelAlertLevel =
  /**
   * The loudest the platform allows, with a vibration pattern (#189,
   * ADR-0039 § 5).
   *
   * **For a ringing call and nothing else.** A ring has to be heard through a
   * pocket in the few seconds before it times out, which is not true of an
   * offer or a message. It is a high-importance notification, not a system
   * call screen — `ConnectionService` is not reachable from the managed
   * workflow — and the sound is the platform's default: a custom ringtone is
   * owner art.
   */
  | 'ring'
  /**
   * A banner over whatever is on screen, with a sound.
   *
   * For the things somebody is waiting on: an offer that expires in seconds, a
   * master who took the job, a job that vanished.
   */
  | 'heads-up'
  /**
   * A sound and a tray entry, with no banner.
   *
   * **Not silent.** "The master has arrived" is a progress step and still has to
   * be heard by somebody standing in their hallway; what it must not do is
   * interrupt four times per job. Silencing it entirely is the user's call to
   * make in system settings, which is exactly what this channel exists to let
   * them do.
   */
  | 'sound-only';

/**
 * Which channel each category is delivered on.
 *
 * **Must equal `CHANNEL_OF_CATEGORY` in
 * `apps/api/src/modules/notifications/notification-categories.ts`.** Android
 * does the matching and reports nothing when it fails: a message naming a
 * channel this app never created is delivered into the manifest's default
 * channel, silently, one category too coarse. The shared
 * {@link NotificationChannelId} keeps the two spellings inside one closed
 * vocabulary; it cannot keep them pointing at the same member, which is what
 * the tests are for.
 *
 * **Every id here is permanent.** Android freezes a channel's settings the
 * first time it is created; changing an id later creates a second channel and
 * leaves the first in the user's own settings list forever.
 */
const CHANNEL_OF_CATEGORY: Readonly<Record<NotificationCategory, NotificationChannelId>> = {
  'order-offers': 'order-offers',
  'order-accepted': 'order-accepted',
  'order-progress': 'order-progress',
  'order-cancelled': 'order-cancelled',
  'order-no-master-found': 'order-no-master-found',
  messages: 'messages',
  calls: 'calls',
};

/**
 * How loudly each category arrives — **the difference is the point of the
 * issue.** An offer is not a status change, and a single channel could only
 * ever be wrong for one of them.
 *
 * Total over {@link NotificationCategory}, so a category added to the contract
 * without a decision here does not compile.
 */
const ALERT_LEVEL_OF_CATEGORY: Readonly<Record<NotificationCategory, ChannelAlertLevel>> = {
  /** A master has seconds to answer, and a broadcast goes to somebody else next. */
  'order-offers': 'heads-up',
  /** The answer to the wait the customer has been sitting through. */
  'order-accepted': 'heads-up',
  /** A stream, not an outcome. Audible, never four banners per job. */
  'order-progress': 'sound-only',
  /** The master who was coming is not coming. */
  'order-cancelled': 'heads-up',
  /** The other outcome of the same wait `order-accepted` ends. */
  'order-no-master-found': 'heads-up',
  /**
   * The other party wrote and it went unread (#180) — "I am at the door".
   * Somebody is waiting on an answer, which is what a banner is for.
   */
  messages: 'heads-up',
  /** Somebody on a live job is ringing, now (#189). */
  calls: 'ring',
};

/**
 * The order the channels are created in, which is the order Android lists them
 * in the phone's own settings screen.
 *
 * It matches the order `GET /notification-preferences` returns and therefore the
 * order of our own settings screen (#147). Two lists of the same switches in two
 * different orders is the sort of detail nobody reports and everybody notices.
 */
const CATEGORY_ORDER = [
  'order-offers',
  'order-accepted',
  'order-progress',
  'order-cancelled',
  'order-no-master-found',
  'messages',
  'calls',
] as const satisfies readonly NotificationCategory[];

/**
 * The list above must name **every** category the contract declares.
 *
 * Type-only, so it costs nothing at runtime: a category added to
 * `@tezusta/types` and not listed leaves `Exclude` non-empty and this stops
 * compiling. Without it a new category would ship with no channel of its own and
 * the only symptom would be a notification arriving one category too coarse —
 * which is precisely the failure Android never reports.
 */
type AssertEveryCategoryIsOrdered<T extends never> = T;
export type _EveryCategoryIsOrdered = AssertEveryCategoryIsOrdered<
  Exclude<NotificationCategory, (typeof CATEGORY_ORDER)[number]>
>;

/**
 * The fallback channel, and the one entry here that is not a category.
 *
 * **Its id has to keep matching `defaultChannel` in `app.config.js`**, which is
 * what the `expo-notifications` plugin writes into the manifest as FCM's default
 * notification channel. It is where a message lands when it names a channel this
 * release has never heard of — a phone that has not been updated after the
 * server learned a new category. Deleting it would turn that case from "arrives
 * in the wrong channel" into "arrives nowhere".
 */
export const DEFAULT_CHANNEL_ID: NotificationChannelId = 'default';

/** One channel, as the platform needs it described. */
export interface NotificationChannel {
  readonly id: NotificationChannelId;
  /** What the phone's settings screen calls it. */
  readonly name: string;
  readonly alertLevel: ChannelAlertLevel;
  /**
   * Milliseconds, alternating wait and vibrate, as Android's
   * `setVibrationPattern` reads it. Absent means the platform's default
   * vibration for the importance — which every channel but `calls` keeps.
   */
  readonly vibrationPattern?: readonly number[];
}

/**
 * The ring's vibration: a pause, then two long pulses a short gap apart — the
 * rhythm a phone call has, so it is told apart from a message in a pocket.
 * Frozen into the `calls` channel the first time a phone creates it (#189).
 */
export const RING_VIBRATION_PATTERN: readonly number[] = [0, 1000, 500, 1000];

/**
 * Every channel this app creates, in the order the settings screen shows them.
 *
 * **The names are the category copy, not new strings.** What a category is
 * called is the owner's (CLAUDE.md §17) and `notifications-copy.ts` already
 * holds the answer for the settings screen; a channel naming itself differently
 * would be the same switch under two names in two places. The default channel
 * keeps the name it shipped with — it is an id that already exists on phones,
 * and renaming a live channel is one of the few things Android does allow, but
 * there is no reason to.
 */
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  {
    id: DEFAULT_CHANNEL_ID,
    name: notificationsCopy.defaultChannelName,
    alertLevel: 'heads-up',
  },
  ...CATEGORY_ORDER.map((category): NotificationChannel => {
    const alertLevel = ALERT_LEVEL_OF_CATEGORY[category];
    return {
      id: CHANNEL_OF_CATEGORY[category],
      name: categoryCopy(category).title,
      alertLevel,
      ...(alertLevel === 'ring' ? { vibrationPattern: RING_VIBRATION_PATTERN } : {}),
    };
  }),
];
