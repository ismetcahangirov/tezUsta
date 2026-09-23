/**
 * The order lifecycle, as the API expresses it across the HTTP boundary.
 *
 * The fourteen values below are not a list this file is free to change. They
 * are fixed by
 * [ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md), and the legal
 * edges between them live in exactly one place —
 * `apps/api/src/modules/orders/order-lifecycle.ts`. Adding a status is a
 * migration, an ADR, and an edit here, in that order.
 *
 * Restated as a literal union rather than derived from the Drizzle `pgEnum`
 * for the reason every other contract in this package is restated: this
 * package is imported by a React Native bundle, and a type that reached
 * through to `drizzle-orm` would drag the server's dependency graph into the
 * app's (ADR-0021).
 */
export type OrderStatus =
  | 'DRAFT'
  | 'SEARCHING'
  | 'ACCEPTED'
  | 'MASTER_ON_THE_WAY'
  | 'MASTER_ARRIVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'DISPUTED'
  | 'RESOLVED'
  | 'REFUNDED'
  | 'NO_MASTER_FOUND'
  | 'CANCELLED';

/**
 * Who caused a status change.
 *
 * `system` is a transition nobody chose — dispatch running out of time, or the
 * re-dispatch cap being reached. Attributing those to whichever person they
 * happened to affect would make the audit trail say something untrue.
 *
 * An `admin` is not a `users` row ([ADR-0014](docs/decisions/ADR-0014-admin-authentication.md)),
 * which is why this is a kind rather than a role on one actor type.
 */
export type OrderActorKind = 'customer' | 'master' | 'admin' | 'system';

/**
 * One order, as a customer's app sees it.
 *
 * Deliberately thin: ids rather than embedded service and address objects.
 * The app already holds the catalogue and the customer's own addresses, and an
 * order that carried copies of both would let the two drift — a service
 * renamed after the order was placed would then read one way in the catalogue
 * and another way in the order list.
 *
 * `masterId` is the only thing said here about who took the job. A master's
 * name, photograph and live position are not an order's business: they reach
 * the customer through the order-tracking surface (EPIC 9), and only while the
 * order is active (`docs/engineering/security.md` § PII and privacy).
 */
export interface Order {
  readonly id: string;
  readonly status: OrderStatus;
  readonly serviceId: string;
  readonly addressId: string;
  readonly description: string;

  /**
   * Integer minor units — `1500` is 15.00 AZN.
   *
   * **Null while the order is searching, and that is not an error state.** The
   * price is frozen at accept, from the accepting master
   * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)), so every read
   * of this field has to handle null rather than treating it as a zero.
   */
  readonly priceMinor: number | null;

  /** Null until a master accepts, and null again after a re-dispatch. */
  readonly masterId: string | null;

  /** How many times this order has gone back out to be dispatched again. */
  readonly redispatchCount: number;

  /** ISO 8601, UTC. Null until a master accepts. */
  readonly acceptedAt: string | null;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  /** ISO 8601, UTC. */
  readonly updatedAt: string;
}

/**
 * An order as the customer's own reads return it — `GET /orders` and
 * `GET /orders/:id` — with the one fact about its conversation the order
 * surfaces need (issue #182).
 *
 * **A separate shape rather than a field on {@link Order}**, because the count
 * is the *reader's*: it is the number of the master's messages the customer has
 * not read. `Order` is also what a transition answers, to a master as often as
 * to a customer, and a field whose meaning depended on who asked would be a
 * number the master's app could misread as their own.
 *
 * **Computed in the same request, for the whole page at once**, so the order
 * list can badge every row without a conversation request per row (CLAUDE.md
 * §12). Zero for an order with no conversation — one still searching, or one
 * that never had a master.
 */
export interface OrderSummary extends Order {
  readonly unreadMessageCount: number;
}
