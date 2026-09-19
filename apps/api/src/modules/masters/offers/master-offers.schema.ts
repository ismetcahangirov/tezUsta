import { z } from 'zod';

/**
 * Validation for the master-facing offer endpoints (issue #101).
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no Fastify
 * type and no Drizzle type appears below.
 *
 * **Every route here carries a body of nothing.** Accept and decline take no
 * parameters at all — who is responding comes from the actor, which offer from
 * the path, and the price from the accepting master's own stored row
 * (ADR-0013). There is deliberately no shape in which a client can name a
 * master, an order, a price or a status, and `.strict()` on an empty object is
 * what turns "the server ignores what you sent" into "the server tells you it
 * was not yours to send". A client that posted `{ "priceMinor": 1 }` believed
 * something about what it was doing, and it is wrong.
 */
export const offerIdParamsSchema = z.object({ offerId: z.string().uuid() }).strict();

export type OfferIdParams = z.infer<typeof offerIdParamsSchema>;

/** The empty body accept and decline both take. See above for why it exists. */
export const offerResponseSchema = z.object({}).strict();

export type OfferResponseRequest = z.infer<typeof offerResponseSchema>;
