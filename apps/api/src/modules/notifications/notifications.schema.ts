import { z } from 'zod';

import { NOTIFICATION_KINDS } from './notification.types';

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
    // Built from the same array the union is derived from, so a kind added
    // to one is added to both. The literal list that used to sit here was a
    // hand-copy, and a hand-copy that fell behind would fail every job of the
    // new kind at the parse above — after it had already been enqueued.
    kind: z.enum(NOTIFICATION_KINDS),
    orderId: z.uuid().optional(),
    orderStatus: z.string().max(64).optional(),
  })
  .strict();

export type NotifyJobPayload = z.infer<typeof notifyJobPayloadSchema>;
