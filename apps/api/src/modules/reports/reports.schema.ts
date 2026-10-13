import { z } from 'zod';

export const REPORT_REASON_CODES = [
  'no_show',
  'rude_or_abusive',
  'unsafe_behaviour',
  'asked_off_platform_payment',
  'damage',
  'other',
] as const;

export const reportOrderIdParamsSchema = z.object({ orderId: z.uuid() }).strict();

/**
 * A report (ADR-0053 § 2–3): a reason from the closed list, and optional
 * words. Blank words are no words — stored as null, as the CHECK expects.
 */
export const submitReportSchema = z
  .object({
    reasonCode: z.enum(REPORT_REASON_CODES),
    text: z
      .string()
      .trim()
      .max(1000)
      .nullish()
      .transform((value) => (value === undefined || value === null || value === '' ? null : value)),
  })
  .strict();

export type SubmitReportInput = z.infer<typeof submitReportSchema>;
