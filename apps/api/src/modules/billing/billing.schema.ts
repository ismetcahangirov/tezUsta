import { z } from 'zod';

/**
 * `POST /masters/me/subscription/checkout`. A billing period and nothing else:
 * `.strict()` refuses an `amountMinor` or a `priceId`, so a client that tries
 * to name its own price is told so rather than silently ignored.
 */
export const startCheckoutSchema = z
  .object({
    billingPeriod: z.enum(['monthly', 'yearly']),
    /** Consent to auto-renewal on the card paid with (ADR-0058). Off unless asked for. */
    autoRenew: z.boolean().default(false),
  })
  .strict();

/** `:provider` in the webhook URL — a provider's name, as `BILLING_PROVIDER` spells it. */
export const billingWebhookParamsSchema = z
  .object({ provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) })
  .strict();
