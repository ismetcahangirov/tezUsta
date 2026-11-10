import { z } from 'zod';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { EMAIL_MAX_LENGTH, normaliseEmail } from '../../infra/email/email-address';

/**
 * Request bodies of support-mediated recovery (#515, ADR-0074 § 2).
 *
 * The address is normalised exactly as sign-in and the self-serve change do,
 * so the request holds the form `users.email` will hold after the move.
 */
const newEmail = z
  .string()
  .max(EMAIL_MAX_LENGTH * 2)
  .transform((value, ctx) => {
    const result = normaliseEmail(value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: 'must be a valid email address' });
      return z.NEVER;
    }
    return result.email;
  });

/** Bounded as every admin reason is: the audit log's CHECK caps it at 600. */
const reason = z.string().trim().min(1).max(600);

export const recoveryIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const openRecoverySchema = z
  .object({
    subject: z.object({ kind: z.enum(['customer', 'master']), id: z.uuid() }).strict(),
    newEmail,
    /** The table's CHECK caps the notes at 4000. */
    evidenceNotes: z.string().trim().min(1).max(4000),
  })
  .strict();

/** Shape only, like sign-in's: a length check here would tell a caller how long the code is. */
export const verifyRecoverySchema = z
  .object({ code: z.string().regex(/^\d{4,12}$/, 'must be a numeric one-time code') })
  .strict();

export const recoveryReasonSchema = z.object({ reason }).strict();

/**
 * The public cancel body. Anything up to a bound is accepted and answered the
 * same way, so a malformed token says no more than a wrong one.
 */
export const cancelByLinkSchema = z.object({ token: z.string().min(1).max(200) }).strict();

export class RecoveryIdParamsDto extends createZodDto(recoveryIdParamsSchema) {}
export class OpenRecoveryDto extends createZodDto(openRecoverySchema) {}
export class VerifyRecoveryDto extends createZodDto(verifyRecoverySchema) {}
export class RecoveryReasonDto extends createZodDto(recoveryReasonSchema) {}
export class CancelByLinkDto extends createZodDto(cancelByLinkSchema) {}
