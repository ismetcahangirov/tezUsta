import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { EMAIL_MAX_LENGTH, normaliseEmail } from '../../infra/email/email-address';

/**
 * The validated shape of both OTP endpoints' request bodies (CLAUDE.md §11 —
 * "validate every input at the API boundary with Zod"), plus the raw-body
 * reader the rate-limit guard needs.
 *
 * Nest-free by construction except for the two `createZodDto` calls, so these
 * schemas move to `packages/validation` as a file when `apps/mobile` starts
 * pre-checking an address before it asks for a code (ADR-0016).
 */

/**
 * A caller-supplied email address, before normalisation (ADR-0072 § 3).
 *
 * Length-capped first, at twice the RFC 5321 limit so surrounding whitespace
 * a keyboard added is still trimmed rather than refused: the normaliser runs a
 * regex, and handing an unbounded string to any regex is a denial-of-service
 * shape (`docs/engineering/security.md`).
 *
 * The failure message is one message for every rejection reason, so the API
 * describes nothing about why an address was refused beyond "not an address".
 */
const emailField = z
  .string()
  .max(EMAIL_MAX_LENGTH * 2)
  .transform((value, ctx) => {
    const result = normaliseEmail(value);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid email address',
      });
      return z.NEVER;
    }
    return result.email;
  });

/**
 * The submitted code, checked for **shape only** — digits, and a length range
 * wide enough to cover every value `OTP_LENGTH` may take.
 *
 * Not `.length(6)`, and that is the interesting part. Pinning the exact
 * configured length here would make a five-digit guess answer 422 while a
 * six-digit one answers 401, so the response would tell an attacker how long
 * the code is before they had ever seen one. It also would not be a security
 * control: a wrong-length code cannot hash to the stored digest anyway, so the
 * only thing the strict check buys is a friendlier error and a leak.
 */
const codeField = z.string().regex(/^\d{4,12}$/, 'must be a numeric one-time code');

/**
 * Client-chosen, never trusted for authorization — it exists so the device
 * list a user sees says "Pixel 7" rather than an opaque uuid. Capped to the
 * `sessions.device_id` column width so an over-long value becomes a 422 here
 * rather than a driver error at insert time, which is exactly what the note on
 * that column asks this schema to do.
 */
const deviceIdField = z.string().min(1).max(128);

export const otpRequestSchema = z.object({
  email: emailField,
});

export const otpVerifySchema = z.object({
  email: emailField,
  code: codeField,
  deviceId: deviceIdField.optional(),
});

export type OtpRequestBody = z.infer<typeof otpRequestSchema>;
export type OtpVerifyBody = z.infer<typeof otpVerifySchema>;

export class OtpRequestDto extends createZodDto(otpRequestSchema) {}
export class OtpVerifyDto extends createZodDto(otpVerifySchema) {}

/**
 * Pulls the rate-limit identifier out of the **raw, unvalidated** body.
 *
 * It has to read the raw body: Nest runs guards before pipes, so
 * `RateLimitGuard` sees the request before `ZodValidationPipe` has parsed
 * anything. That ordering is also why this normalises rather than trusting the
 * string — `Ali@Example.com` and `ali@example.com` are one person, and a
 * counter keyed on the raw text is bypassed with the shift key
 * (`common/decorators/rate-limit.decorator.ts` says exactly this).
 *
 * Returns `undefined` for a body that carries no usable address, which the
 * guard reads as "no identifier dimension for this request". The per-IP limit
 * still applies, so a malformed body is never a free request, and answering a
 * 429 here for what is really a 422 would be the wrong error.
 */
export function otpEmailIdentifier(request: FastifyRequest): string | undefined {
  const { body } = request;
  if (typeof body !== 'object' || body === null || !('email' in body)) {
    return undefined;
  }

  const value: unknown = (body as Record<string, unknown>).email;
  if (typeof value !== 'string' || value.length > EMAIL_MAX_LENGTH * 2) {
    return undefined;
  }

  const result = normaliseEmail(value);
  return result.ok ? result.email : undefined;
}
