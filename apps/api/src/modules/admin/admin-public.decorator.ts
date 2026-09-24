import type { ExecutionContext } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const ADMIN_PUBLIC_ROUTE = 'tezusta:admin-public-route';

/**
 * An `/admin` route that is reached **before** there is an admin session —
 * the setup link and the sign-in form (ADR-0043 § 3–4).
 *
 * Every other `/admin` route is authenticated because of its path, and this
 * marker is the one exception, so it is deliberately narrow: it skips admin
 * authentication and permission checks and nothing else. Such a handler must
 * authenticate its caller itself (a setup token, a password and a code) and
 * carry its own `@RateLimit`. `admin-credentials.e2e.test.ts` pins the list of
 * routes that carry it, so a new one is a reviewed change.
 */
export const PublicAdminRoute = (): MethodDecorator => SetMetadata(ADMIN_PUBLIC_ROUTE, true);

/**
 * Whether the handler carries `@PublicAdminRoute()`. Method-level only: a
 * whole public controller under `/admin` is not a thing this codebase wants
 * to be able to write.
 */
export function isPublicAdminRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.get<boolean | undefined>(ADMIN_PUBLIC_ROUTE, context.getHandler()) === true;
}
