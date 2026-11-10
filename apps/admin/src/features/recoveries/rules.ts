import type { AdminAccountRecovery, AdminMe } from '@tezusta/types';

import { formatDateTime } from '../../format';
import { recoveriesCopy } from './copy';

/**
 * What the panel can tell before asking the server (#517). **Guidance only**:
 * the API (#515) enforces every one of these rules again, and the server's
 * refusal is what the admin sees if this read was stale.
 */

/** The hold's remaining time, or `null` when there is no hold running. */
export function holdLeft(recovery: AdminAccountRecovery, now: Date): string | null {
  if (
    recovery.holdUntil === null ||
    recovery.status === 'moved' ||
    recovery.status === 'cancelled'
  ) {
    return null;
  }
  const ms = new Date(recovery.holdUntil).getTime() - now.getTime();
  if (ms <= 0) return recoveriesCopy.holdOver;
  const minutes = Math.ceil(ms / 60_000);
  return recoveriesCopy.holdLeft(Math.floor(minutes / 60), minutes % 60);
}

/**
 * Why this admin cannot approve this request now, or `null` when they can.
 * Hidden entirely, rather than explained, for an admin who is not a
 * super admin: there is nothing they could do about it.
 */
export function approveBlocker(
  me: AdminMe,
  recovery: AdminAccountRecovery,
  now: Date,
): string | null {
  if (recovery.openedByAdminId === me.id) return recoveriesCopy.approveNotOpener;
  if (recovery.holdUntil === null) return recoveriesCopy.approveWaitCode;
  if (new Date(recovery.holdUntil).getTime() > now.getTime()) {
    return recoveriesCopy.approveWaitHold(formatDateTime(recovery.holdUntil));
  }
  return null;
}

export function canApprove(me: AdminMe): boolean {
  return me.roles.includes('super_admin') && me.permissions.includes('accounts.recover');
}

/** Whether the request can still end in a move. */
export function isOpen(recovery: AdminAccountRecovery): boolean {
  return recovery.status !== 'moved' && recovery.status !== 'cancelled';
}

export function adminName(me: AdminMe, adminId: string | null, name: string | null): string {
  if (adminId === null) return recoveriesCopy.none;
  const shown = name ?? recoveriesCopy.unknownAdmin;
  return adminId === me.id ? `${shown} (${recoveriesCopy.you})` : shown;
}
