import type { AdminPermission } from '@tezusta/types';
import type { ComponentType } from 'react';

import { AdminsPage } from '../features/admins/AdminsPage';
import { AuditPage } from '../features/audit/AuditPage';
import { CataloguePage } from '../features/catalogue/CataloguePage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { MasterDetailPage } from '../features/masters/MasterDetailPage';
import { MastersPage } from '../features/masters/MastersPage';
import { DisputesPage } from '../features/orders/DisputesPage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { OrdersPage } from '../features/orders/OrdersPage';
import { ReviewsPage } from '../features/reviews/ReviewsPage';

/**
 * The page each navigation section renders, keyed by its path in
 * `NAVIGATION`. A section with no entry here is still a placeholder. Each
 * feature adds one line; the section's permission guard stays in `App.tsx`.
 */
export const PAGES: Partial<Record<string, ComponentType>> = {
  '/': DashboardPage,
  '/masters': MastersPage,
  '/orders': OrdersPage,
  '/disputes': DisputesPage,
  '/catalogue': CataloguePage,
  '/reviews': ReviewsPage,
  '/audit': AuditPage,
  '/admins': AdminsPage,
};

export interface NestedPage {
  /** A router path beneath a section, e.g. `/masters/:id`. */
  readonly path: string;
  /** The permission that guards it — the same one as its section's. */
  readonly permission: AdminPermission;
  readonly component: ComponentType;
}

/** Pages reached from inside a section rather than from the navigation. */
export const NESTED_PAGES: readonly NestedPage[] = [
  { path: '/masters/:id', permission: 'masters.read', component: MasterDetailPage },
  { path: '/orders/:id', permission: 'orders.read', component: OrderDetailPage },
];
