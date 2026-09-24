/**
 * The admin panel's identity contracts
 * ([ADR-0043](../../../docs/decisions/ADR-0043-admin-panel-policy.md) § 1).
 *
 * Types only, like everything in this package. The server enforces the
 * role → permission bundles; the panel reads `AdminMe.permissions` to decide
 * what to show, which is a convenience and never the check.
 */

/** The four admin roles. An admin holds one or more. */
export type AdminRole = 'support' | 'moderator' | 'finance' | 'super_admin';

/** Every permission an admin handler can require. */
export type AdminPermission =
  | 'dashboard.read'
  | 'orders.read'
  | 'orders.override'
  | 'disputes.resolve'
  | 'disputes.refund'
  | 'pii.read'
  | 'calls.read'
  | 'masters.read'
  | 'masters.review'
  | 'masters.suspend'
  | 'reviews.moderate'
  | 'catalogue.manage'
  | 'audit.read'
  | 'admins.manage';

/** `GET /admin/me` — the signed-in admin, read from the database on this request. */
export interface AdminMe {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
  /** The union of the roles' bundles, in a stable order. */
  readonly permissions: readonly AdminPermission[];
}
