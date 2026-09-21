import type { OrderStatus } from '@tezusta/types';

import type { NotificationKind } from './notification.types';

/**
 * Everything the recipient rule needs, and deliberately nothing else.
 *
 * **User ids, never profile ids.** A notification is addressed to an account,
 * because one binary carries both roles (CLAUDE.md §2) and a device belongs to
 * a person rather than to one of their two profiles. Resolving
 * `orders.customer_id` and `orders.master_id` into the accounts behind them is
 * the caller's job; by the time the rule below runs, "the customer" and "the
 * actor" are comparable values, which is what makes the exclusion one line
 * instead of a case analysis.
 */
export interface OrderTransitionFacts {
  /** The status the transaction actually committed — never the one asked for. */
  readonly to: OrderStatus;
  /** The account behind `orders.customer_id`, if there is one. */
  readonly customerUserId: string | undefined;
  /**
   * The account behind `orders.master_id` **as the committed row holds it**.
   *
   * `undefined` while searching, and `undefined` after a re-dispatch, which
   * clears the column in the same transaction.
   */
  readonly masterUserId: string | undefined;
  /**
   * Who performed the transition, when that is a person with an account.
   *
   * `undefined` for an admin and for the system — neither has an account in
   * this family, so neither is ever in the recipient set and neither needs
   * excluding.
   */
  readonly actorUserId: string | undefined;
}

/** One queued notification: who, and what about. */
export interface PlannedNotification {
  readonly userId: string;
  readonly kind: NotificationKind;
}

/**
 * What a committed status is worth telling somebody.
 *
 * Total over `OrderStatus` by type, so a status added to ADR-0015 is a compile
 * error here until somebody decides whether it is worth a push — rather than
 * silently falling through to whatever the neighbouring branch did.
 *
 * `null` means "nothing to say", and it is the honest answer for six of the
 * fourteen. `DRAFT` is a status nothing reaches from outside creation, and the
 * money statuses belong to EPIC 12: inventing copy for a payment flow nobody
 * has designed would be exactly the kind of product decision CLAUDE.md §17
 * reserves for the owner.
 */
const KIND_OF_STATUS: Readonly<Record<OrderStatus, NotificationKind | null>> = Object.freeze({
  DRAFT: null,
  SEARCHING: 'order-redispatched',
  ACCEPTED: 'order-accepted',
  MASTER_ON_THE_WAY: 'order-status-changed',
  MASTER_ARRIVED: 'order-status-changed',
  IN_PROGRESS: 'order-status-changed',
  COMPLETED: 'order-status-changed',
  CANCELLED: 'order-cancelled',
  NO_MASTER_FOUND: 'order-no-master-found',
  PAYMENT_PENDING: null,
  PAID: null,
  DISPUTED: null,
  RESOLVED: null,
  REFUNDED: null,
});

/**
 * Does this status have anything to say at all?
 *
 * Exported so a caller can answer that **before** looking up who the parties
 * are — every transition in the system reaches the raiser, and the ones no
 * Epic has given words to should cost no reads. Asking this function rather
 * than reading {@link KIND_OF_STATUS} again elsewhere is what keeps the answer
 * one opinion instead of two that can drift.
 */
export function isNotifiableStatus(to: OrderStatus): boolean {
  return KIND_OF_STATUS[to] !== null;
}

/**
 * Who to tell about one committed transition.
 *
 * **"Nobody is notified of their own action" is one subtraction, applied
 * once.** The Epic asks for that guarantee by construction rather than per
 * call site, and this is the construction: the recipients of any transition
 * are the order's two parties, and the actor is removed from them. Every case
 * the issue enumerates falls out of it without a branch of its own —
 *
 * - an accept excludes the accepting master, who is the actor;
 * - a customer cancellation reaches the assigned master and not the customer;
 * - a cancellation with no master assigned reaches nobody at all;
 * - an admin override reaches both parties, because an admin is in neither
 *   the recipient set nor the actor position of this family;
 * - a re-dispatch reaches the customer alone, the dropped master having been
 *   removed from the row by the same transaction.
 *
 * `SEARCHING` here always means a re-dispatch. Order creation enters
 * `SEARCHING` too and raises nothing, because it never travels this path —
 * telling customers about an order they just created would be telling them
 * what they are already looking at.
 */
export function planTransitionNotifications(facts: OrderTransitionFacts): PlannedNotification[] {
  const kind = KIND_OF_STATUS[facts.to];
  if (kind === null) {
    return [];
  }

  const recipients = [facts.customerUserId, facts.masterUserId].filter(
    (userId): userId is string => userId !== undefined && userId !== facts.actorUserId,
  );

  return unique(recipients).map((userId) => ({ userId, kind }));
}

/**
 * Who to tell about one broadcast wave: every master it reached, and nobody
 * else.
 *
 * **One job per recipient, never one job per broadcast.** A wave reaching
 * twenty masters is twenty notifications, so one unreachable device does not
 * take the other nineteen's delivery and retry semantics with it.
 *
 * There is no actor to exclude and no second exclusion to apply. The master a
 * re-dispatch took the job from is already absent from the wave, because the
 * broadcast upsert never re-offers an `accepted` row — adding an exclusion
 * here would be a second rule that could drift from the first, which is what
 * the issue asks not to build.
 */
export function planOfferNotifications(reachedUserIds: readonly string[]): PlannedNotification[] {
  return unique(reachedUserIds).map((userId) => ({ userId, kind: 'order-offer' as const }));
}

/**
 * Order-preserving de-duplication.
 *
 * The same person twice is one notification, not two. It is reachable for a
 * transition only if one account holds both profiles on one order — which
 * nothing today produces — and per wave if a broadcast ever offered the same
 * master twice. Neither is worth a branch; both are worth not double-pushing.
 */
function unique(userIds: readonly string[]): string[] {
  return [...new Set(userIds)];
}
