import type { AdminPermission, AdminRole } from '@tezusta/types';

/**
 * Every admin permission, in the order ADR-0043 § 1 lists them.
 *
 * The union type lives in `packages/types` because the panel reads it too (to
 * hide what an admin cannot do); this array is the runtime copy the server
 * enforces. `satisfies` plus the exhaustiveness check below keep the two from
 * drifting: a permission added to the type and not here fails to compile.
 */
export const ADMIN_PERMISSIONS = [
  'dashboard.read',
  'orders.read',
  'orders.override',
  'disputes.resolve',
  'disputes.refund',
  'pii.read',
  'calls.read',
  'masters.read',
  'masters.review',
  'masters.suspend',
  'reviews.moderate',
  'catalogue.manage',
  'audit.read',
  'admins.manage',
] as const satisfies readonly AdminPermission[];

type MissingPermission = Exclude<AdminPermission, (typeof ADMIN_PERMISSIONS)[number]>;
// Compiles only while the array names every member of the union.
const EVERY_PERMISSION_LISTED: MissingPermission extends never ? true : false = true;
void EVERY_PERMISSION_LISTED;

/**
 * What each role may do — ADR-0043 § 1's table, and nothing else.
 *
 * Fixed in code rather than stored: a role is a product decision, and changing
 * what `support` can do is a reviewed change to this file with its own test,
 * not a row somebody edits in production. The *assignment* of roles to people
 * is data (`admin_user_roles`).
 */
export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  support: [
    'dashboard.read',
    'orders.read',
    'orders.override',
    'disputes.resolve',
    'pii.read',
    'calls.read',
    'masters.read',
  ],
  moderator: [
    'dashboard.read',
    'orders.read',
    'masters.read',
    'masters.review',
    'masters.suspend',
    'reviews.moderate',
  ],
  finance: ['dashboard.read', 'orders.read', 'disputes.resolve', 'disputes.refund'],
  super_admin: ADMIN_PERMISSIONS,
};

/** The union of every held role's bundle, in the canonical order. */
export function permissionsFor(roles: readonly AdminRole[]): readonly AdminPermission[] {
  const held = new Set<AdminPermission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      held.add(permission);
    }
  }
  return ADMIN_PERMISSIONS.filter((permission) => held.has(permission));
}
