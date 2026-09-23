import type { NotificationCategory } from './notification-preference.js';

/**
 * The Android notification channel a push is addressed to.
 *
 * **A contract, and an unusually unforgiving one.** The sender names a channel
 * id in the message (`apps/api/src/infra/push/expo-push-sender.ts`) and the app
 * creates channels under ids of its own
 * (`apps/mobile/src/notifications/notification-channels.ts`). Android does the
 * matching, silently: a message naming a channel the phone does not have is
 * delivered into the manifest's default channel, with no error anywhere for
 * anyone to read. So the two lists have to agree, and agreeing is what this
 * type is for.
 *
 * **The ids are permanent.** A channel's importance, sound and vibration are
 * frozen the first time it is created and cannot be changed by code
 * afterwards; changing them means a new id, which leaves the old channel
 * sitting in the user's own settings list forever. Renaming one of these is
 * therefore not a refactor.
 *
 * It is spelled as the category union plus `'default'` rather than as free
 * text, so a channel nobody creates cannot be addressed. The two are equal
 * strings today and are still mapped rather than assumed equal — see
 * `CHANNEL_OF_CATEGORY` in the API, which is the seam that lets a category be
 * renamed without orphaning a channel on every phone that has it.
 *
 * `'default'` is the fallback and is not a category: it is the channel named by
 * the `expo-notifications` plugin's `defaultChannel` option in
 * `apps/mobile/app.config.js`, and it is what a phone running an older release
 * lands on when the server sends a category that release has never heard of.
 */
export type NotificationChannelId = NotificationCategory | 'default';

/**
 * What a push notification is about.
 *
 * **This union is a contract between the API and the app**, and it lives here
 * for the reason CLAUDE.md §2 gives: it crosses the boundary between the two
 * workspaces, so a copy on either side is a copy that can drift. The kind is
 * the key three separate things are keyed by — the notification copy, the
 * preference category it belongs to, and the screen a tapped notification
 * opens — and a drifted vocabulary would break the third silently, because a
 * kind the app does not recognise simply does not navigate.
 *
 * **The runtime list stays in `apps/api`.** This package ships TypeScript
 * source with no build step, which holds only while every export is a type
 * (ADR-0021); an array here would make it a real dependency of the React
 * Native bundle. The API keeps `NOTIFICATION_KINDS` and checks it against this
 * union at compile time, and the app needs no list at all — an exhaustive
 * `Record<NotificationKind, …>` is what makes a missing destination a type
 * error there.
 *
 * Two kinds the Epic lists are deliberately absent: "master nearby" needs a
 * live position stream (EPIC 9) and "review reminder" needs reviews (EPIC 11).
 */
export type NotificationKind =
  /** To each master a broadcast reached: there is work nearby. */
  | 'order-offer'
  /** To the customer: a master took the job. */
  | 'order-accepted'
  /** To the customer: the assigned master moved the order along. */
  | 'order-status-changed'
  /** To the counterparty: the order was cancelled. */
  | 'order-cancelled'
  /** To the customer: the assigned master dropped the job and the search resumed. */
  | 'order-redispatched'
  /** To the customer: the search ended with nobody. */
  | 'order-no-master-found'
  /**
   * To either party: the other one wrote on the order's conversation and the
   * message was still unread a few seconds later (issue #180). Names the sender
   * and the order; never carries the message body.
   */
  | 'message-received';

/**
 * What a notification payload may carry, and therefore what it may not.
 *
 * **A closed set of optional members with no index signature**, so a field
 * named `address`, `phone` or `latitude` does not compile. A lock screen is
 * readable by whoever is holding the phone, and a notification is the one
 * surface that shows data to somebody who has not authenticated (CLAUDE.md
 * §11).
 *
 * **There is deliberately no route, path or URL member.** The app derives its
 * destination from `kind` plus an id, through a table it holds itself. A
 * payload that could name a screen would be a stranger on the network
 * choosing what the app renders and with which parameters — the same reason
 * every other input is validated rather than trusted.
 *
 * `kind` is typed as the union here and widened to `string` where it is
 * *received*: this describes what the API sends, and the app still parses
 * what arrived rather than asserting it.
 */
export interface PushData {
  readonly kind: NotificationKind;
  readonly orderId?: string | undefined;
  readonly orderStatus?: string | undefined;
}
