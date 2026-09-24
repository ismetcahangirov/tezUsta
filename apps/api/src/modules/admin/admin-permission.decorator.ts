import { SetMetadata } from '@nestjs/common';
import type { AdminPermission } from '@tezusta/types';

/** Reflector key for what an admin handler requires. */
export const ADMIN_PERMISSION_KEY = 'tezusta:admin-permission';

/**
 * The declaration every `/admin` handler must carry (ADR-0043 § 1).
 *
 * - `{ anyOf: [...] }` — the admin must hold at least one of these. A single
 *   permission is the common case; more than one is for a handler whose
 *   *exact* requirement depends on its input and is refined in the service
 *   (an order transition's target decides between `orders.override` and the
 *   two dispute outcomes).
 * - `{ anyOf: [] }` — any authenticated admin. Written out as
 *   `@AnyAdmin()` so the choice is visible in review.
 *
 * A handler with **no** declaration is refused by `AdminPermissionGuard`.
 */
export interface AdminPermissionRequirement {
  readonly anyOf: readonly AdminPermission[];
}

export const RequireAdminPermission = (
  first: AdminPermission,
  ...rest: AdminPermission[]
): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AdminPermissionRequirement>(ADMIN_PERMISSION_KEY, {
    anyOf: [first, ...rest],
  });

/** Any authenticated admin — `GET /admin/me` and nothing that acts on anyone. */
export const AnyAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AdminPermissionRequirement>(ADMIN_PERMISSION_KEY, { anyOf: [] });
