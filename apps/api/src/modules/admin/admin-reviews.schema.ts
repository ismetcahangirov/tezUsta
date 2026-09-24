import { z } from 'zod';

/**
 * `POST /admin/ratings/recalculate` (#223): one master, one customer, or —
 * with an empty body — everybody. Naming both is refused rather than
 * interpreted: "recalculate these two unrelated profiles" is two requests.
 */
export const recalculateRatingsSchema = z
  .object({
    masterId: z.uuid().optional(),
    customerId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => value.masterId === undefined || value.customerId === undefined, {
    message: 'Name a master, a customer, or neither — not both.',
    path: ['customerId'],
  });

export type RecalculateRatingsBody = z.infer<typeof recalculateRatingsSchema>;
