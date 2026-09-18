import type { OrderStatus } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

/**
 * Who a given edge belongs to, expressed as a requirement rather than a role.
 *
 * `claimingMaster` and `assignedMaster` are two different things and the
 * distinction is load-bearing: the master who accepts a `SEARCHING` order is by
 * definition **not** yet assigned to it, and the master who says they have
 * arrived must be. One value for both would make "any master may report any
 * order as arrived" typecheck.
 *
 * `admin` is deliberately absent. An admin may drive any edge the table
 * contains ([ADR-0015](docs/decisions/ADR-0015-order-lifecycle-states.md)
 * § Admin override), so listing them on every edge would be noise that a later
 * reader could remove from one line by accident.
 */
type EdgeActor = 'system' | 'customer' | 'assignedMaster' | 'claimingMaster';

type OrderTransitionTable = {
  readonly [From in OrderStatus]: Readonly<Partial<Record<OrderStatus, readonly EdgeActor[]>>>;
};

/**
 * **The transition table. There is no second one.**
 *
 * Every edge in ADR-0015, and the actor requirement for each. Scattering these
 * rules through the services that perform the transitions is precisely how a
 * state machine ends up with two disagreeing answers to "can this happen", so
 * the services call `assertOrderTransition` and this file is the only thing
 * that knows.
 *
 * Two facts are folded into one structure on purpose. The edge and who may
 * drive it are read together on every single transition, and a separate actor
 * table would be a second thing to keep in step — the first missing row would
 * be an edge with no owner, which would then be either open to everyone or
 * closed to everyone, depending on which way the lookup happened to fail.
 *
 * Adding an edge here is not a code change. It is a new ADR superseding
 * ADR-0015, then this table, then the test that transcribes the ADR
 * independently.
 */
const ORDER_TRANSITIONS: OrderTransitionTable = {
  /**
   * `DRAFT` exists so that creation can be idempotent: the row and the client's
   * idempotency key are written together, and the move to `SEARCHING` happens
   * in the same transaction. The customer never sees this status.
   */
  DRAFT: {
    SEARCHING: ['system'],
    CANCELLED: ['customer'],
  },
  SEARCHING: {
    /** First accept wins. The guard that makes "first" true is the conditional
     * UPDATE in the accept path, not this check — see
     * [ADR-0009](docs/decisions/ADR-0009-dispatch-model.md). */
    ACCEPTED: ['claimingMaster'],
    /** Supply ran out. **Not** a cancellation — nobody cancelled anything, and
     * collapsing the two corrupts the cancellation-rate metric. */
    NO_MASTER_FOUND: ['system'],
    CANCELLED: ['customer'],
  },
  ACCEPTED: {
    MASTER_ON_THE_WAY: ['assignedMaster'],
    /** Re-dispatch. The assigned master fell through; the order goes back out. */
    SEARCHING: ['assignedMaster'],
    CANCELLED: ['customer'],
  },
  MASTER_ON_THE_WAY: {
    MASTER_ARRIVED: ['assignedMaster'],
    SEARCHING: ['assignedMaster'],
    CANCELLED: ['customer'],
  },
  MASTER_ARRIVED: {
    IN_PROGRESS: ['assignedMaster'],
    SEARCHING: ['assignedMaster'],
    CANCELLED: ['customer'],
  },
  /**
   * No re-dispatch out of `IN_PROGRESS`, and that is deliberate in ADR-0015:
   * once work has started, a different master cannot pick the job up.
   */
  IN_PROGRESS: {
    COMPLETED: ['assignedMaster'],
    CANCELLED: ['customer'],
  },
  COMPLETED: {
    /** The card path — the charge is asynchronous, so the order waits. */
    PAYMENT_PENDING: ['system'],
    /**
     * The cash path. Money changed hands in a hallway, so there is nothing to
     * settle and nothing to wait for.
     *
     * Attributed to `system` for now because **who confirms a cash payment is
     * an EPIC 12 question** that ADR-0007 leaves open. If the answer turns out
     * to be "the master taps received", this edge gains `assignedMaster` — here,
     * with its own test, rather than as a bypass in a payments service.
     */
    PAID: ['system'],
    DISPUTED: ['customer'],
  },
  PAYMENT_PENDING: {
    PAID: ['system'],
    DISPUTED: ['customer'],
  },
  PAID: {
    DISPUTED: ['customer'],
  },
  /**
   * Both outcomes are admin-only, and both require a reason. The empty actor
   * lists are not an oversight — an admin needs no entry, because an admin may
   * drive any edge the table contains.
   */
  DISPUTED: {
    RESOLVED: [],
    REFUNDED: [],
  },
  RESOLVED: {},
  REFUNDED: {},
  NO_MASTER_FOUND: {},
  CANCELLED: {},
};

/** Every status, in the order ADR-0015 lists them. Derived, never restated. */
export const ORDER_STATUSES = Object.keys(ORDER_TRANSITIONS) as readonly OrderStatus[];

/**
 * The actor asking for a transition, carrying the one fact about them this
 * decision needs.
 *
 * The booleans are answers the caller has already established against the
 * order row — this file never reads the database, which is what lets the whole
 * state machine be tested without one.
 */
export type OrderTransitionActor =
  | { readonly kind: 'system' }
  | { readonly kind: 'admin' }
  | { readonly kind: 'customer'; readonly isOrderCustomer: boolean }
  | { readonly kind: 'master'; readonly isAssignedMaster: boolean };

/** The status pair is not an edge in the table at all. */
export class InvalidOrderTransitionError extends AppError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(
      ERROR_CODES.ORDER_INVALID_TRANSITION,
      'This order cannot move to that state.',
      409,
      // Both values are the client's own order's states, so neither leaks
      // anything the caller could not already read.
      { from, to },
    );
    this.name = 'InvalidOrderTransitionError';
    Object.setPrototypeOf(this, InvalidOrderTransitionError.prototype);
  }
}

/**
 * The edge exists, but not for this actor.
 *
 * 403 rather than the 404 that "not yours" gets elsewhere: by the time a
 * transition is attempted the caller has already passed the visibility check,
 * so the order's existence is not a secret being kept from them. What is being
 * refused is the operation.
 */
export class OrderTransitionNotPermittedError extends AppError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(
      ERROR_CODES.ORDER_TRANSITION_NOT_PERMITTED,
      'You cannot make that change to this order.',
      403,
      { from, to },
    );
    this.name = 'OrderTransitionNotPermittedError';
    Object.setPrototypeOf(this, OrderTransitionNotPermittedError.prototype);
  }
}

/** The statuses an order in `from` may legally move to. Possibly none. */
export function allowedNextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return Object.keys(ORDER_TRANSITIONS[from]) as readonly OrderStatus[];
}

/** An order here is finished, whatever happened to it. Nothing moves it again. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return allowedNextStatuses(status).length === 0;
}

function satisfiesEdgeActor(required: EdgeActor, actor: OrderTransitionActor): boolean {
  switch (required) {
    case 'system':
      return actor.kind === 'system';
    case 'customer':
      return actor.kind === 'customer' && actor.isOrderCustomer;
    case 'assignedMaster':
      return actor.kind === 'master' && actor.isAssignedMaster;
    case 'claimingMaster':
      return actor.kind === 'master' && !actor.isAssignedMaster;
  }
}

/**
 * The only way an order's status changes.
 *
 * Throws rather than returning a boolean, because a caller that forgets to read
 * a boolean has written a transition with no check at all, and that mistake is
 * invisible in review.
 *
 * @throws InvalidOrderTransitionError when the pair is not an edge — 409.
 * @throws OrderTransitionNotPermittedError when it is, but not for this actor — 403.
 */
export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderTransitionActor,
): void {
  const permitted: readonly EdgeActor[] | undefined = ORDER_TRANSITIONS[from][to];

  if (permitted === undefined) {
    throw new InvalidOrderTransitionError(from, to);
  }

  // An admin bypasses the actor check and never the edge table (ADR-0015).
  if (actor.kind === 'admin') {
    return;
  }

  if (!permitted.some((required) => satisfiesEdgeActor(required, actor))) {
    throw new OrderTransitionNotPermittedError(from, to);
  }
}
