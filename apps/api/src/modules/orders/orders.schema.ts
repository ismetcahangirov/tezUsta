import { z } from 'zod';

/**
 * Validation for the order endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no Fastify
 * type and no Drizzle type appears below, so the day `apps/mobile` reuses these
 * shapes the move to `packages/validation` is a file move rather than a
 * rewrite.
 */

/**
 * How much a customer must type before the app will submit.
 *
 * The table's own CHECK bounds this at 1–2000 — its job is to keep an empty or
 * unbounded value out of the column, whatever writes it. The **product**
 * minimum is here, because it is a statement about what makes a dispatchable
 * request rather than about what makes a valid row.
 *
 * Ten characters is short enough for a real Azerbaijani sentence — *"Kran
 * sızır"* is ten — and long enough to refuse a single tapped letter. A master
 * deciding whether to drive across Baku needs more than "su".
 */
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * The client's key for "this is the same request I already sent".
 *
 * Bounded but not shaped: a UUID is what the app will send, and requiring one
 * would be this endpoint deciding how a client generates its own retry token.
 * What matters is that it is short, non-empty, and the same across retries of
 * one intent — none of which a format check makes truer.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * `.strict()` so an unknown key is a 422 rather than a silently dropped field.
 *
 * It is also the mass-assignment guard that matters most on this endpoint:
 * `priceMinor`, `status` and `masterId` are all columns on the row this
 * request creates, and all three are the server's to decide. A body carrying
 * any of them is refused rather than quietly ignored — the client that sent it
 * believed something, and it should be told it was wrong.
 */
export const createOrderSchema = z
  .object({
    serviceId: z.string().uuid(),
    addressId: z.string().uuid(),
    description: z.string().trim().min(MIN_DESCRIPTION_LENGTH).max(MAX_DESCRIPTION_LENGTH),
    idempotencyKey: z.string().trim().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH),
  })
  .strict();

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
