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
