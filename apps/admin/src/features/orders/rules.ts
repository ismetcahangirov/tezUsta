import type { AdminPermission, OrderStatus } from '@tezusta/types';

import { ordersCopy } from './copy';

/** Every status an order can be filtered by — all of them but `DRAFT`. */
export const FILTERABLE_STATUSES: readonly OrderStatus[] = [
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
  'NO_MASTER_FOUND',
  'CANCELLED',
];

/** Any one of these lets an admin open the override dialog (ADR-0043 § 1). */
export const OVERRIDE_PERMISSIONS: readonly AdminPermission[] = [
  'orders.override',
  'disputes.resolve',
  'disputes.refund',
];

/**
 * Which permission a move to `to` needs — the rule the API applies in
 * `permissionForAdminTransition`. This is not the state machine: *which*
 * moves exist comes from the server in `detail.transitions`; this only says
 * whose role may make one of them.
 */
export function permissionForTarget(to: OrderStatus): AdminPermission {
  if (to === 'RESOLVED') return 'disputes.resolve';
  if (to === 'REFUNDED') return 'disputes.refund';
  return 'orders.override';
}

type ErrorCode = keyof typeof ordersCopy.errors;

/** The message for a failed order action, by the API's stable `error.code`. */
export function orderErrorMessage(code: string | undefined): string {
  if (code !== undefined && code !== 'unexpected' && code in ordersCopy.errors) {
    return ordersCopy.errors[code as ErrorCode];
  }
  return ordersCopy.errors.unexpected;
}

/** The first eight characters of an order's UUID — enough to tell rows apart. */
export function shortOrderId(orderId: string): string {
  return orderId.slice(0, 8);
}
