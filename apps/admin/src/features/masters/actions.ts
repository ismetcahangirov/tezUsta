import type { AdminPermission, MasterVerificationStatus } from '@tezusta/types';

import type { MasterAction } from './api';

/** In the order the detail page offers them. */
export const MASTER_ACTIONS: readonly MasterAction[] = [
  'verify',
  'request-more',
  'reject',
  'suspend',
  'reinstate',
];

/** ADR-0043 § 1: review decisions and suspension are separate permissions. */
export const ACTION_PERMISSION: Readonly<Record<MasterAction, AdminPermission>> = {
  verify: 'masters.review',
  reject: 'masters.review',
  'request-more': 'masters.review',
  suspend: 'masters.suspend',
  reinstate: 'masters.suspend',
};

/** The three negative outcomes carry a reason the master reads (ADR-0023). */
export const ACTION_NEEDS_REASON: Readonly<Record<MasterAction, boolean>> = {
  verify: false,
  reject: true,
  'request-more': true,
  suspend: true,
  reinstate: false,
};

/**
 * Which statuses each action is offered from — a copy of `ALLOWED_FROM` in
 * `apps/api/src/modules/admin/admin-masters.service.ts`, because the master
 * detail does not say which actions apply.
 *
 * **Presentation only.** It decides which buttons are drawn, so an admin is
 * not offered a decision the server will refuse; the server re-checks every
 * action, and if this copy ever drifts the admin sees the `CONFLICT` message
 * and a refreshed page rather than a wrong status.
 */
const OFFERED_FROM: Readonly<Record<MasterAction, readonly MasterVerificationStatus[]>> = {
  verify: ['pending_verification', 'changes_requested', 'rejected'],
  reject: ['pending_verification', 'changes_requested'],
  'request-more': ['pending_verification', 'changes_requested'],
  suspend: ['pending_verification', 'changes_requested', 'rejected', 'active'],
  reinstate: ['suspended'],
};

/** The actions this admin may take on a master in `status`, in display order. */
export function availableActions(
  status: MasterVerificationStatus,
  permissions: readonly AdminPermission[],
): MasterAction[] {
  return MASTER_ACTIONS.filter(
    (action) =>
      permissions.includes(ACTION_PERMISSION[action]) && OFFERED_FROM[action].includes(status),
  );
}
