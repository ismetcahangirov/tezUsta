import type { CustomDecorator } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';

import type { UserRoleName } from '../../infra/database/schema/users';

/** Reflector key for {@link Roles}. Namespaced — see {@link IS_PUBLIC_ROUTE}. */
export const REQUIRED_ROLES = 'auth:requiredRoles';

/**
 * Restricts a route to callers holding **at least one** of the named roles, as
 * enforced by `RolesGuard` against the roles read from the database.
 *
 * "At least one" rather than "all", because roles are a set and a user may hold
 * both (`docs/product/user-roles.md`: a plumber with a broken fridge is one
 * account with two grants). A route needing two simultaneous conditions is not
 * expressing a role requirement — it is expressing a business rule, and that
 * belongs in the service that owns it.
 *
 * The parameter type requires at least one role at compile time, so `@Roles()`
 * — which reads as a restriction and enforces nothing — cannot be written.
 *
 * `'admin'` is deliberately not in {@link UserRoleName}: an admin is a separate
 * account in its own table with its own token family
 * ([ADR-0014](docs/decisions/ADR-0014-admin-authentication.md)), and an admin
 * token does not pass consumer token verification at all, so it never reaches
 * this decorator. Admin-only routes get their own guard in EPIC 13; adding
 * `'admin'` here would make it grantable to a phone-OTP account.
 */
export const Roles = (
  ...roles: readonly [UserRoleName, ...UserRoleName[]]
): CustomDecorator<typeof REQUIRED_ROLES> => SetMetadata(REQUIRED_ROLES, roles);
