import type { AdminPermission, AdminRole } from '@tezusta/types';
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

/** The exact prefix, or the prefix followed by a slash — never `/adminx`. */
function isUnderAdminPrefix(path: string): boolean {
  return path === ADMIN_PATH_PREFIX || path.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/**
 * The route pattern the router matched for this request (`/admin/orders/:id`),
 * or `undefined` when there is none — a test double, or a request no route
 * answered.
 *
 * Read defensively: `routeOptions` is a getter on Fastify's own request object
 * and absent from a hand-built one.
 */
export function matchedRoutePattern(request: FastifyRequest): string | undefined {
  const routeOptions: unknown = (request as { routeOptions?: unknown }).routeOptions;
  if (typeof routeOptions !== 'object' || routeOptions === null) {
    return undefined;
  }
  const url: unknown = (routeOptions as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

/**
 * Whether the route the router matched lives under `/admin`. `false` when no
 * route was matched — this answers only about the pattern.
 */
export function isAdminRoutePattern(request: FastifyRequest): boolean {
  const pattern = matchedRoutePattern(request);
  return pattern !== undefined && isUnderAdminPrefix(pattern);
}

/**
 * The request's path as the router would see it: query string cut off, then
 * percent-decoded. A sequence that does not decode is compared as sent — the
 * router would have refused it before any guard ran.
 */
function decodedRequestPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

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
 * **"Where it lives" means the route the router matched, not the URL the
 * client sent** (#269). The router normalises a path — percent-decoding it,
 * among other things — before matching, so several spellings of a URL reach
 * one handler. Deciding from the raw string would let the router and this
 * function disagree about which handler a request is for, and any disagreement
 * is a request the admin guards step aside from while an admin handler
 * answers it. The matched pattern is the router's own answer, and guards run
 * after routing, so every request a guard sees has one.
 *
 * The raw URL is still consulted, decoded, and **either** signal claiming the
 * request makes it admin. On a real request the two agree; where only the URL
 * is available (a test double) it is the whole answer; and if they ever
 * disagreed, failing towards the admin guards costs a caller a 401 rather than
 * opening a handler. The query string is cut off first: `/adminx?foo=/admin`
 * must not match, and neither must anything else that only contains the
 * prefix.
 */
export function isAdminRequest(request: FastifyRequest): boolean {
  if (isAdminRoutePattern(request)) {
    return true;
  }
  // Typed as a string by Fastify and always set on a real request; read
  // defensively anyway, because a hand-built test double or a future adapter
  // that omits it must not crash the guard chain. No url means no path, and
  // no path is not the admin surface — which is also the WebSocket answer.
  const url: unknown = request.url;
  if (typeof url !== 'string') {
    return false;
  }
  return isUnderAdminPrefix(decodedRequestPath(url));
}

/**
 * Claims in an admin access token.
 *
 * `sub` is an `admin_users` id and **never** a `users` id. There is no `roles`
 * claim, and there will not be one: roles are read from `admin_user_roles` on
 * every request (ADR-0043 § 1), so a revoked role stops working on the next
 * request rather than fifteen minutes later.
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
  /** From `admin_user_roles`, on this request. */
  readonly roles: readonly AdminRole[];
  /** The union of the roles' bundles (`admin-permissions.ts`). */
  readonly permissions: readonly AdminPermission[];
}

/** DI token for the admin auth configuration. */
export const ADMIN_CONFIG = Symbol('ADMIN_CONFIG');
