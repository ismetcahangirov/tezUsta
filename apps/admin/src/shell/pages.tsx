import type { AdminPermission } from '@tezusta/types';
import type { ComponentType } from 'react';

import { CataloguePage } from '../features/catalogue/CataloguePage';
import { MasterDetailPage } from '../features/masters/MasterDetailPage';
import { MastersPage } from '../features/masters/MastersPage';
import { DisputesPage } from '../features/orders/DisputesPage';
import { OrderDetailPage } from '../features/orders/OrderDetailPage';
import { OrdersPage } from '../features/orders/OrdersPage';

/**
 * The page each navigation section renders, keyed by its path in
 * `NAVIGATION`. A section with no entry here is still a placeholder. Each
 * feature adds one line; the section's permission guard stays in `App.tsx`.
 */
export const PAGES: Partial<Record<string, ComponentType>> = {
  '/masters': MastersPage,
  '/orders': OrdersPage,
  '/disputes': DisputesPage,
  '/catalogue': CataloguePage,
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
