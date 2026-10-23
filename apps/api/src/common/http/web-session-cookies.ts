import type { FastifyRequest } from 'fastify';

/**
 * The master's web subscription page's two session cookies
 * ([ADR-0061](docs/decisions/ADR-0061-master-web-subscription-page.md) § 2).
 * The same attributes as the admin panel's: `HttpOnly`, `SameSite=Strict`,
 * `Path=/`, and `Secure` everywhere but local development.
 *
 * Here, in `common`, because two layers read them: the authentication guard,
 * and the rate limiter's per-user key in `infra`, which may not import a
 * module.
 */
export const WEB_ACCESS_COOKIE = 'tz_web_at';
export const WEB_REFRESH_COOKIE = 'tz_web_rt';

/**
 * The CSRF header every cookie-authenticated web request must carry, for the
 * reason `ADMIN_CSRF_HEADER` gives: a cross-site page cannot add a custom
 * header without a preflight, and this API answers none.
 */
export const WEB_CSRF_HEADER = 'x-tezusta-web';

export function hasWebCsrfHeader(request: FastifyRequest): boolean {
  return request.headers[WEB_CSRF_HEADER] === '1';
}
