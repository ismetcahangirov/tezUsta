import type { FastifyRequest } from 'fastify';

/*
 * The few cookie helpers this API needs, for the two browser surfaces that use
 * cookies: the admin panel (ADR-0043 § 4) and the master's web subscription
 * page (ADR-0061). Hand-rolled rather than `@fastify/cookie`, because every
 * value is one this server wrote itself.
 */

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
