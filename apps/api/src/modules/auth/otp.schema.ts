import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { normaliseAzerbaijaniPhone } from '../../infra/phone/azerbaijani-phone';

/**
 * The validated shape of both OTP endpoints' request bodies (CLAUDE.md §11 —
 * "validate every input at the API boundary with Zod"), plus the raw-body
 * reader the rate-limit guard needs.
 *
 * Nest-free by construction except for the two `createZodDto` calls, so these
 * schemas move to `packages/validation` as a file when `apps/mobile` starts
 * pre-checking a number before it asks for a code (ADR-0016).
 */

/**
 * A caller-supplied phone number, before normalisation.
 *
 * Length-capped first: the normaliser strips non-digits with a regex, and
 * handing an unbounded string to any regex is a denial-of-service shape
 * (`docs/engineering/security.md`). 32 characters is generous for every way a
 * human writes `+994 XX XXX XX XX`.
 *
 * The failure message is deliberately one message for every rejection reason.
 * `normaliseAzerbaijaniPhone` distinguishes `wrong_length` from
 * `not_azerbaijani` from `not_a_valid_number` — useful in a server log, and
 * not something to hand back field by field, because the more precisely the
 * API describes why a number was refused the more cheaply an attacker can
 * enumerate which prefixes exist.
 */
const phoneField = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const result = normaliseAzerbaijaniPhone(value);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid Azerbaijani phone number',
      });
      return z.NEVER;
    }
    return result.e164;
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
  phone: phoneField,
});

export const otpVerifySchema = z.object({
  phone: phoneField,
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
 * string — `+994 50 111 22 33` and `+994501112233` are one person, and a
 * counter keyed on the raw text is bypassed with a space bar
 * (`common/decorators/rate-limit.decorator.ts` says exactly this).
 *
 * Returns `undefined` for a body that carries no usable number, which the
 * guard reads as "no identifier dimension for this request". The per-IP limit
 * still applies, so a malformed body is never a free request, and answering a
 * 429 here for what is really a 422 would be the wrong error.
 */
export function otpPhoneIdentifier(request: FastifyRequest): string | undefined {
  const { body } = request;
  if (typeof body !== 'object' || body === null || !('phone' in body)) {
    return undefined;
  }

  const value: unknown = (body as Record<string, unknown>).phone;
  if (typeof value !== 'string' || value.length > 32) {
    return undefined;
  }

  const result = normaliseAzerbaijaniPhone(value);
  return result.ok ? result.e164 : undefined;
}
