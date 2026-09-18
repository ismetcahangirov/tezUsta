import type { FastifyRequest } from 'fastify';

/**
 * The admin token family's issuer and audience.
 *
 * The issuer matches the consumer path's (`tezusta-api` — it is the same
 * server) and **the audience deliberately does not**.
 * [ADR-0014](docs/decisions/ADR-0014-admin-authentication.md) requires that
 * "the two paths do not share an issuer, an audience claim, or a refresh
 * family", and the audience is the claim that makes it structural: a consumer
 * access token presented to an admin route fails `aud`, and an admin token
 * presented to a consumer route fails it in the other direction. Neither
 * verifier has to remember to check anything extra, because each rejects the
 * other's audience by construction.
 *
 * They also do not share a signing secret (`JWT_ADMIN_ACCESS_SECRET`), so even
 * a bug that accepted the wrong audience would still fail the signature.
 */
export const ADMIN_TOKEN_ISSUER = 'tezusta-api';
export const ADMIN_TOKEN_AUDIENCE = 'tezusta-admin';

/** The path prefix that defines the admin surface. */
export const ADMIN_PATH_PREFIX = '/admin';

/**
 * Whether this request is for the admin surface.
 *
 * **Path-based rather than decorator-based, and that is the security
 * argument.** A `@AdminRoute()` marker would be one forgotten decorator away
 * from a disaster: the consumer `AuthenticationGuard` would pick the route up,
 * a customer's access token would authenticate, and with no `@Roles()` on the
 * handler `RolesGuard` would wave it through — an ordinary user reaching an
 * endpoint that suspends masters. Keying on the prefix means a new route under
 * `/admin` is guarded because of where it lives, not because somebody
 * remembered. `admin-verification.e2e.test.ts` walks the live route
 * table and asserts it.
 *
 * The query string is cut off first: `/adminx?foo=/admin` must not match, and
 * neither must anything else that only contains the prefix.
 */
export function isAdminRequest(request: FastifyRequest): boolean {
  // Typed as a string by Fastify and always set on a real request; read
  // defensively anyway, because a hand-built test double or a future adapter
  // that omits it must not crash the guard chain. No url means no path, and
  // no path is not the admin surface.
  const url: unknown = request.url;
  if (typeof url !== 'string') {
    return false;
  }
  const path = url.split('?')[0] ?? '';
  return path === ADMIN_PATH_PREFIX || path.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/**
 * Claims in an admin access token.
 *
 * `sub` is an `admin_users` id and **never** a `users` id. There is no `roles`
 * claim: admin permissions are EPIC 13's, and a claim carrying a permission
 * set nothing yet grants would be a claim somebody later trusts.
 */
export interface AdminAccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly iss: typeof ADMIN_TOKEN_ISSUER;
  readonly aud: typeof ADMIN_TOKEN_AUDIENCE;
  readonly iat: number;
  readonly exp: number;
}

/**
 * The authenticated admin, resolved from the database on **every** request.
 *
 * Deliberately not `Actor`, and deliberately not assignable to it. An admin
 * holds no consumer roles and no `users` row, so a handler that accidentally
 * took one where it wanted the other would not compile
 * (`docs/product/admin-flow.md` § "Admin is web, not mobile").
 */
export interface AdminActor {
  readonly adminUserId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
}

/** DI token for the admin auth configuration. */
export const ADMIN_CONFIG = Symbol('ADMIN_CONFIG');
