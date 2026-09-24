import type { OrderStatus } from '@tezusta/types';

import { ordersCopy } from './copy';

const LIVE = 'bg-inverse-surface text-on-inverse';
const SETTLED = 'bg-surface-alt text-text';
const ENDED = 'bg-surface-alt text-text-muted';

const TONE: Record<OrderStatus, string> = {
  DRAFT: ENDED,
  SEARCHING: 'bg-accent text-on-accent',
  ACCEPTED: LIVE,
  MASTER_ON_THE_WAY: LIVE,
  MASTER_ARRIVED: LIVE,
  IN_PROGRESS: LIVE,
  COMPLETED: SETTLED,
  PAYMENT_PENDING: SETTLED,
  PAID: SETTLED,
  DISPUTED: 'bg-danger text-on-danger',
  RESOLVED: ENDED,
  REFUNDED: ENDED,
  NO_MASTER_FOUND: ENDED,
  CANCELLED: ENDED,
};

/**
 * An order's status as a pill: accent while searching, inverse while a
 * master is engaged, danger for a dispute, muted once it is over.
 */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-caption font-bold ${TONE[status]}`}
    >
      {ordersCopy.status[status]}
    </span>
  );
}
