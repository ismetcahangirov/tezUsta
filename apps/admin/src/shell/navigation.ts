import type { AdminPermission } from '@tezusta/types';

import { copy } from '../copy';

export interface NavigationItem {
  readonly path: string;
  readonly label: string;
  /** Hides the item and guards the route. A convenience only: the server checks again. */
  readonly permission: AdminPermission;
  /** The issue that builds the page; until then it is a placeholder. */
  readonly issue: number;
}

/**
 * The panel's sections, in navigation order (ADR-0043 § 1 for the
 * permissions). Disputes need only `orders.read` to be seen — resolving one
 * is `disputes.resolve`, checked on the action, not on the page.
 */
export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: copy.nav.dashboard, permission: 'dashboard.read', issue: 251 },
  { path: '/masters', label: copy.nav.masters, permission: 'masters.read', issue: 248 },
  { path: '/orders', label: copy.nav.orders, permission: 'orders.read', issue: 249 },
  { path: '/disputes', label: copy.nav.disputes, permission: 'orders.read', issue: 249 },
  { path: '/catalogue', label: copy.nav.catalogue, permission: 'catalogue.manage', issue: 250 },
  { path: '/reviews', label: copy.nav.reviews, permission: 'reviews.moderate', issue: 251 },
  { path: '/audit', label: copy.nav.audit, permission: 'audit.read', issue: 251 },
  { path: '/admins', label: copy.nav.admins, permission: 'admins.manage', issue: 251 },
];

export function visibleNavigation(
  permissions: readonly AdminPermission[],
): readonly NavigationItem[] {
  return NAVIGATION.filter((item) => permissions.includes(item.permission));
}
