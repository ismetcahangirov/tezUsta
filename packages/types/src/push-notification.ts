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
  | 'order-no-master-found';

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
