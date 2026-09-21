import { z } from 'zod';

/**
 * The job payload, validated on the way **out** of the queue.
 *
 * A payload has been through Redis and is no more trusted than a request body
 * (`queue.types.ts`). The realistic threat is not an attacker with Redis
 * access — they would have worse options — but a **deploy boundary**: a job
 * enqueued by the previous release, picked up by this one, carrying a shape
 * this code no longer expects. Parsing turns that into a failed job with a
 * legible error instead of a push addressed to `undefined`.
 *
 * `.strict()` for the same reason it is used at the HTTP boundary: a field
 * quietly dropped is a field somebody thought they were sending.
 */
export const notifyJobPayloadSchema = z
  .object({
    userId: z.uuid(),
    kind: z.enum([
      'order-offer',
      'order-accepted',
      'order-status-changed',
      'order-cancelled',
      'order-no-master-found',
    ]),
    orderId: z.uuid().optional(),
    orderStatus: z.string().max(64).optional(),
  })
  .strict();

export type NotifyJobPayload = z.infer<typeof notifyJobPayloadSchema>;
