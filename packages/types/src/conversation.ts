/**
 * The written channel between the two parties to one order.
 *
 * **A conversation is a property of an order, not of a pair of people**
 * ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)). That is the one
 * thing to hold on to while reading the shapes below: there is no thread id a
 * client keeps across jobs, no membership list, and nothing here says who the
 * other party *is* — a master's name and photograph reach the customer through
 * the order surface, and only while the order is live
 * (`docs/engineering/security.md` § PII and privacy).
 *
 * Restated as literal unions rather than derived from the Drizzle enums, for
 * the reason `order.ts` gives: this package is imported by a React Native
 * bundle, and a type that reached through to `drizzle-orm` would drag the
 * server's dependency graph into the app's (ADR-0021).
 */

/**
 * Which side of the order wrote a message.
 *
 * Deliberately a *role on this order*, not a user id and not an actor kind
 * shared with anything else. A client renders "mine" or "theirs" from it
 * without holding either party's identity, and one human who is both a
 * customer and a master is unambiguous here because the order decides which
 * side they are on.
 *
 * There is no `admin` and no `system`. An admin reading a dispute reads the
 * transcript; they do not write into it, and a support message that looked
 * like it came from the other party would be the worst possible thing to add
 * to an argument about money.
 */
export type MessageSenderKind = 'customer' | 'master';

/**
 * One order's conversation, as either party's app sees it.
 *
 * `writable` is the field that matters and it is **derived, not stored**: a
 * conversation accepts messages while its order is live and stops when the
 * order reaches a terminal status (ADR-0033 § 2). The server computes it from
 * the order's current status on every read, so a client that caches a
 * conversation from an hour ago and trusts this flag will simply be refused by
 * the send endpoint — which is the correct failure, and the reason the flag is
 * a hint for the UI rather than the authorization.
 */
export interface Conversation {
  readonly id: string;
  readonly orderId: string;
  /**
   * Messages in this conversation the caller has not read.
   *
   * Always the *caller's* count. Two parties reading the same conversation
   * get different numbers from the same endpoint, and neither is told the
   * other's.
   */
  readonly unreadCount: number;
  /**
   * Whether the send endpoint will currently accept a message. See the note on
   * this interface: a hint, never the check.
   */
  readonly writable: boolean;
  readonly createdAt: string;
  /**
   * When this conversation stopped being the order's current one, because the
   * order was re-dispatched and the master who held it is no longer on the job.
   * `null` for the conversation a live order is using.
   *
   * **Not the same thing as `writable`.** A cancelled order's conversation is
   * unwritable and was never closed; a re-dispatched order's previous
   * conversation is closed and its replacement is writable.
   */
  readonly closedAt: string | null;
}

/** One message. */
export interface Message {
  readonly id: string;
  readonly conversationId: string;
  /** Which side of the order wrote it — see {@link MessageSenderKind}. */
  readonly senderKind: MessageSenderKind;
  readonly body: string;
  readonly createdAt: string;
  /**
   * When the *other* party read it, for a message the caller sent; `null` if
   * they have not.
   *
   * Always `null` on a message the caller received, and deliberately so: a
   * read receipt is information about the reader, and telling somebody when
   * they themselves read something is noise at best.
   */
  readonly readAt: string | null;
}
