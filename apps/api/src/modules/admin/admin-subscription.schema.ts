import { z } from 'zod';

import { MAX_GRANT_DAYS } from '../subscriptions/subscription-transitions';

/**
 * Bodies for the admin subscription surface (#324). Every write is strict and
 * carries a reason, which is what the audit trail is made of.
 */

const reason = z.string().trim().min(1).max(600);

/** Integer minor units. The ceiling is the admin money parser's (`apps/admin` `money.ts`). */
const priceMinor = z.number().int().min(1).max(10_000_000);

export const changeSubscriptionPricesSchema = z
  .object({
    monthlyMinor: priceMinor.optional(),
    yearlyMinor: priceMinor.optional(),
    effectiveFrom: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    confirmLargeChange: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine((body) => body.monthlyMinor !== undefined || body.yearlyMinor !== undefined, {
    message: 'Name at least one price.',
    path: ['monthlyMinor'],
  });

export const updateSubscriptionSettingsSchema = z
  .object({
    trialDays: z.number().int().min(0).max(90).optional(),
    graceDays: z.number().int().min(0).max(30).optional(),
    purchasesOpen: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (body) =>
      body.trialDays !== undefined ||
      body.graceDays !== undefined ||
      body.purchasesOpen !== undefined,
    { message: 'Change at least one setting.', path: ['trialDays'] },
  );

export const subscriptionReasonSchema = z.object({ reason }).strict();

export const grantSubscriptionSchema = z
  .object({ days: z.number().int().min(1).max(MAX_GRANT_DAYS), reason })
  .strict();

export const priceIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type ChangeSubscriptionPricesBody = z.infer<typeof changeSubscriptionPricesSchema>;
export type UpdateSubscriptionSettingsBody = z.infer<typeof updateSubscriptionSettingsSchema>;
