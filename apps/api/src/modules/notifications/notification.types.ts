/**
 * What a notification is about.
 *
 * A closed union rather than free text, because it is the key three other
 * things are keyed by: the copy table below it, the preference categories
 * (#143), and the screen a tapped notification opens (#146). A free-text kind
 * would let any of those three drift out of step with the other two and give
 * no compile error when it did.
 *
 * **The vocabulary lives here; the triggers do not.** Issue #144 is what
 * raises these from the order and dispatch paths. Defining them in the module
 * that owns the copy is what keeps `renderNotification` exhaustive — adding a
 * kind is then a compile error until its copy exists, rather than a
 * notification that arrives with an empty body.
 *
 * Two kinds the Epic lists are deliberately absent: "master nearby" needs a
 * live position stream (EPIC 9) and "review reminder" needs reviews
 * (EPIC 11). Each arrives with its own Epic, the habit
 * [ADR-0016](../../../../../docs/decisions/ADR-0016-shared-package-timing.md)
 * applies to packages and `queue.constants.ts` applies to queues.
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
  /** To the customer: the search ended with nobody. */
  | 'order-no-master-found';

/**
 * What a caller asks for, and everything the mechanism needs.
 *
 * **Ids, never objects** — ADR-0025's rule, and here it is load-bearing
 * rather than stylistic: by the time the job runs, the order may have been
 * accepted by somebody else and the device may have been retired. The job
 * re-reads; the request only names.
 */
export interface NotificationRequest {
  /** Who to tell. Their devices are resolved when the job runs, not now. */
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly orderId?: string | undefined;
  readonly orderStatus?: string | undefined;
}
