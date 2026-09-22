import type { OrderStatus } from '@tezusta/types';

import type { StatusTone } from '../components';
import { ORDERS_COPY } from './orders-copy';

/**
 * How one order status is shown to a customer
 * ([ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
 *
 * **A tone, a label and a sentence — not a step number.** The lifecycle is not
 * a line: a re-dispatch sends an accepted order back to `SEARCHING` (#136), a
 * dispute branches away from payment, and `NO_MASTER_FOUND` ends the journey
 * without reaching anything drawn after it. Any stepper honest about that is a
 * diagram rather than a component, which is why this maps to a pill and a line
 * of text instead of to a position.
 *
 * **The colour never carries the meaning.** Three tones are shared by several
 * statuses on purpose (`docs/design/design-system.md` § Status); what
 * distinguishes them is the label, and what a person is actually waiting to
 * read is `next`.
 */
export interface OrderStatusPresentation {
  readonly tone: StatusTone;
  /** Where the order is. */
  readonly label: string;
  /** What happens next — the half a person waiting at home wants. */
  readonly next: string;
}

/**
 * Which tone each status wears.
 *
 * Total over {@link OrderStatus}, so a status added to
 * [ADR-0015](../../../../docs/decisions/ADR-0015-order-lifecycle-states.md)
 * without a decision here does not compile — the alternative being an order
 * screen that renders a blank pill for a state the server is perfectly capable
 * of sending.
 *
 * `unfilled` exists for exactly one member. `NO_MASTER_FOUND` is not a
 * cancellation — nobody cancelled; the platform had no supply — and painting it
 * in the failure colour is the visual form of the conflation that status exists
 * to prevent. It is not `pending` either, because it is terminal.
 */
const TONE_OF_STATUS: Readonly<Record<OrderStatus, StatusTone>> = {
  DRAFT: 'pending',
  SEARCHING: 'pending',
  ACCEPTED: 'active',
  MASTER_ON_THE_WAY: 'active',
  MASTER_ARRIVED: 'active',
  IN_PROGRESS: 'active',
  COMPLETED: 'done',
  PAYMENT_PENDING: 'active',
  PAID: 'done',
  /** Waiting on somebody else's decision, which is what `pending` means here. */
  DISPUTED: 'pending',
  RESOLVED: 'done',
  REFUNDED: 'done',
  NO_MASTER_FOUND: 'unfilled',
  CANCELLED: 'cancelled',
};

/**
 * Whether anybody is still waiting on this order
 * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
 *
 * **The question is "is someone waiting", not "can this ever change again".**
 * `PAID` is finished here even though the transition table still allows
 * `PAID → DISPUTED`: the work is done, the money moved, and nothing is expected
 * of the customer, the master or the platform. An order list that filed a paid
 * order under "in progress" because a dispute remains theoretically possible
 * would be describing the schema rather than the customer's day.
 *
 * Total over {@link OrderStatus} for the same reason `TONE_OF_STATUS` is: a
 * status added to ADR-0015 without a decision here must fail the build, not
 * quietly sort itself into the finished half.
 *
 * `DRAFT` is open. It is an in-flight creation the customer never sees, and
 * "not finished" is the only truthful answer for it.
 */
const OPEN_BY_STATUS: Readonly<Record<OrderStatus, boolean>> = {
  DRAFT: true,
  SEARCHING: true,
  ACCEPTED: true,
  MASTER_ON_THE_WAY: true,
  MASTER_ARRIVED: true,
  IN_PROGRESS: true,
  COMPLETED: true,
  PAYMENT_PENDING: true,
  DISPUTED: true,
  PAID: false,
  RESOLVED: false,
  REFUNDED: false,
  NO_MASTER_FOUND: false,
  CANCELLED: false,
};

/** Whether the order still has something outstanding for somebody. */
export function isOrderOpen(status: OrderStatus): boolean {
  return OPEN_BY_STATUS[status];
}

/**
 * The pill and the sentence for one status.
 *
 * Pure, and deliberately not a component: what a status looks like is a
 * decision the screen renders, and a function is what lets it be tested without
 * one.
 */
export function presentOrderStatus(status: OrderStatus): OrderStatusPresentation {
  return {
    tone: TONE_OF_STATUS[status],
    label: ORDERS_COPY.status[status].label,
    next: ORDERS_COPY.status[status].next,
  };
}
