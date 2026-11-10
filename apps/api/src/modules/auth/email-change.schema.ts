import { z } from 'zod';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { EMAIL_MAX_LENGTH, normaliseEmail } from '../../infra/email/email-address';

/**
 * The two request bodies of the self-serve address change (#514, ADR-0074 § 1).
 *
 * The address field is the same rule sign-in applies (`otp.schema.ts`): capped
 * before the normaliser's regex runs, one message for every rejection.
 */
const newEmailField = z
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

/** Shape only, like sign-in's: a length check here would tell a caller how long the code is. */
const codeField = z.string().regex(/^\d{4,12}$/, 'must be a numeric one-time code');

export const emailChangeStartSchema = z.object({ newEmail: newEmailField });

export const emailChangeConfirmSchema = z.object({
  /** The code sent to the address the account has now. */
  currentCode: codeField,
  /** The code sent to the new address. */
  newCode: codeField,
});

export class EmailChangeStartDto extends createZodDto(emailChangeStartSchema) {}
export class EmailChangeConfirmDto extends createZodDto(emailChangeConfirmSchema) {}
