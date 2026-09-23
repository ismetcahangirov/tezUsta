import type { NotificationKind } from '@tezusta/types';

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
export const NOTIFICATION_KINDS = Object.freeze([
  /** To each master a broadcast reached: there is work nearby. */
  'order-offer',
  /** To the customer: a master took the job. */
  'order-accepted',
  /** To the customer: the assigned master moved the order along. */
  'order-status-changed',
  /** To the counterparty: the order was cancelled. */
  'order-cancelled',
  /**
   * To the customer: the assigned master dropped the job and the search
   * resumed (#136, #144).
   *
   * Distinct from `order-cancelled` because the order did **not** end — the
   * customer is back in a queue rather than out of one, and a body telling
   * them their order was cancelled would be wrong about the only thing they
   * need to know.
   */
  'order-redispatched',
  /** To the customer: the search ended with nobody. */
  'order-no-master-found',
  /**
   * To either party: the other one wrote and it went unread (#180). Raised by
   * `MessageNotificationsService`, never by an order transition.
   */
  'message-received',
] as const) satisfies readonly NotificationKind[];

/**
 * **The union now comes from `@tezusta/types`, and the array stays here.**
 *
 * The kind crosses into `apps/mobile`, which reads it to decide which screen a
 * tapped notification opens (issue #146), so the vocabulary is a contract and
 * belongs in the shared package (CLAUDE.md §2). The runtime list does not
 * follow it there: that package ships source with no build step, which holds
 * only while every export is a type (ADR-0021), and an array would make it a
 * real dependency of the React Native bundle.
 *
 * The array still earns its place here for the reason issue #143 added it:
 * `notifications.schema.ts` builds its Zod enum from it instead of retyping
 * the members, which had drifted apart by one hand-copied list before.
 */
export type { NotificationKind };

/**
 * The array above must list **every** kind the contract declares.
 *
 * Type-only, so it costs nothing at runtime: if `@tezusta/types` gains a kind
 * that `NOTIFICATION_KINDS` does not list, `Exclude` is non-empty and this
 * stops compiling. Without it the array could fall behind the contract and the
 * only symptom would be a notification the app declines to route, raised by a
 * server that never knew it was sending an unknown kind.
 *
 * The converse — a kind in the array that the contract does not declare — is
 * caught by the `satisfies` on the array itself.
 */
type AssertEveryKindIsListed<T extends never> = T;
export type _EveryKindIsListed = AssertEveryKindIsListed<
  Exclude<NotificationKind, (typeof NOTIFICATION_KINDS)[number]>
>;

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
  /**
   * Which side of the order wrote, for `message-received` only (#180). The
   * worker resolves that side's display name when it renders — the job names,
   * it does not carry the name.
   */
  readonly senderKind?: 'customer' | 'master' | undefined;
}
