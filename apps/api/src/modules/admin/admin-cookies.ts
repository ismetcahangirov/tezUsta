import type { FastifyRequest } from 'fastify';

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

/**
 * Reads one cookie from the `Cookie` header — the few lines RFC 6265 § 5.4
 * needs for values this server wrote itself, rather than a dependency.
 * The first occurrence wins, as browsers send the most specific path first.
 */
export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}

/**
 * One `Set-Cookie` value. Every value written here is base64url or a JWT, so
 * nothing needs escaping; a value outside that alphabet is a programming error.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!/^[A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Refusing to write cookie ${name} with characters outside base64url/JWT.`);
  }
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
  ];
  if (options.secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/** Both cookies, expired — sign-out and every refused refresh. */
export function clearedAdminCookies(secure: boolean): string[] {
  return [
    serializeCookie(ADMIN_ACCESS_COOKIE, '', { maxAgeSeconds: 0, secure }),
    serializeCookie(ADMIN_REFRESH_COOKIE, '', { maxAgeSeconds: 0, secure }),
  ];
}
