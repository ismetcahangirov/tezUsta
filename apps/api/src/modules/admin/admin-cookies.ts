import type { FastifyRequest } from 'fastify';

import { serializeCookie } from '../../common/http/cookies';

// Moved to `common/http/cookies.ts` for the web page's use too (ADR-0061);
// re-exported so the admin module's imports stay where they were.
export { readCookie, serializeCookie } from '../../common/http/cookies';
export type { CookieOptions } from '../../common/http/cookies';

/**
 * The admin panel's two session cookies (ADR-0043 § 4). Both `HttpOnly`,
 * `SameSite=Strict`, `Path=/`, and `Secure` everywhere but local development,
 * where the Vite proxy speaks plain http.
 */
export const ADMIN_ACCESS_COOKIE = 'tz_admin_at';
export const ADMIN_REFRESH_COOKIE = 'tz_admin_rt';

/**
 * The CSRF header every cookie-authenticated admin request must carry.
 *
 * `SameSite=Strict` already keeps the cookies off cross-site requests; this is
 * the second, independent wall. A cross-site page cannot add a custom header
 * without a CORS preflight, and this API answers no preflight at all.
 */
export const ADMIN_CSRF_HEADER = 'x-tezusta-admin';

export function hasAdminCsrfHeader(request: FastifyRequest): boolean {
  return request.headers[ADMIN_CSRF_HEADER] === '1';
}

/** Both cookies, expired — sign-out and every refused refresh. */
export function clearedAdminCookies(secure: boolean): string[] {
  return [
    serializeCookie(ADMIN_ACCESS_COOKIE, '', { maxAgeSeconds: 0, secure }),
    serializeCookie(ADMIN_REFRESH_COOKIE, '', { maxAgeSeconds: 0, secure }),
  ];
}
