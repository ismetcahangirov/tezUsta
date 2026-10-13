import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ADMIN_REFRESH_COOKIE, readCookie } from './admin-cookies';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './credentials/password-hash';

/** 32 random bytes, base64url — exactly what `issueInvitation` produces. */
const setupToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be a setup token');

export const adminSetupStartSchema = z.object({ token: setupToken }).strict();

export const adminSetupCompleteSchema = z
  .object({
    token: setupToken,
    // No trim: a password is exactly what was typed, spaces included.
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    // Absent on a password-reset link (#329), which enrols nothing.
    enrolment: z.string().min(1).max(1024).optional(),
    code: z.string().regex(/^\d{6}$/, 'must be six digits'),
  })
  .strict();

/**
 * The rate-limit subject for the setup routes: the SHA-256 of the token, so
 * the limiter's keys never hold a usable link. A body with no token is still
 * counted per IP.
 */
export function setupTokenIdentifier(request: FastifyRequest): string | undefined {
  const { body } = request;
  if (typeof body !== 'object' || body === null || !('token' in body)) {
    return undefined;
  }
  const value: unknown = (body as Record<string, unknown>).token;
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * `POST /admin/me/password` (#329). The new password follows the setup rule;
 * the current one is only compared, so it carries just the upper bound.
 */
export const adminPasswordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    code: z.string().regex(/^\d{6}$/, 'must be six digits'),
  })
  .strict();

export const adminSignInSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(320),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    code: z.string().regex(/^\d{6}$/, 'must be six digits'),
  })
  .strict();

/** The sign-in rate-limit subject: the lower-cased email, as the account is keyed. */
export function adminEmailIdentifier(request: FastifyRequest): string | undefined {
  const { body } = request;
  if (typeof body !== 'object' || body === null || !('email' in body)) {
    return undefined;
  }
  const value: unknown = (body as Record<string, unknown>).email;
  if (typeof value !== 'string' || value.length > 320) {
    return undefined;
  }
  return value.trim().toLowerCase();
}

/** The refresh rate-limit subject: the SHA-256 of the refresh cookie, never the cookie. */
export function refreshCookieIdentifier(request: FastifyRequest): string | undefined {
  const value = readCookie(request, ADMIN_REFRESH_COOKIE);
  return value === undefined ? undefined : createHash('sha256').update(value, 'utf8').digest('hex');
}
