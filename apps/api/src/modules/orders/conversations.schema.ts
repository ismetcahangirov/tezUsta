import { z } from 'zod';

/**
 * Validation for the conversation endpoints (issue #178).
 * Pre-`packages/validation` code (ADR-0016): no Nest, Fastify or Drizzle type
 * appears below.
 */

/**
 * The most messages one page may return, and the default.
 *
 * A chat page is read on a phone and scrolled back through, so the default is
 * a screenful and a half rather than a screenful — the common gesture is one
 * flick, and a page that ends mid-flick costs a round trip. The ceiling is
 * what stops a client asking for a whole transcript in one response over a
 * mobile connection.
 */
export const MAX_MESSAGE_PAGE_SIZE = 100;
export const DEFAULT_MESSAGE_PAGE_SIZE = 30;

/**
 * The longest message body the API accepts, matching the column's CHECK and
 * `orders.description`'s bound.
 *
 * The two bounds are deliberately the same number in two places rather than
 * one shared constant reaching across the boundary: Zod guards the request
 * path and the CHECK guards the table against everything else that ever writes
 * it, and they are not the same guarantee. The e2e suite asserts they agree.
 */
export const MAX_MESSAGE_BODY_LENGTH = 2000;

export const orderIdParamsSchema = z.object({ orderId: z.uuid() }).strict();

export const listMessagesQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_MESSAGE_PAGE_SIZE)
      .default(DEFAULT_MESSAGE_PAGE_SIZE),
  })
  .strict();

/**
 * **`trim()` before the length check, and a minimum of one.**
 *
 * A body of spaces is not a message, and letting one through would put a row
 * in a transcript that renders as nothing — in a dispute, an empty bubble
 * somebody has to explain. Trimming here also keeps the request bound and the
 * column's `length(btrim(...))` CHECK measuring the same string, so a body
 * that passes Zod cannot then be refused by Postgres as a 500.
 */
export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_MESSAGE_BODY_LENGTH),
  })
  .strict();

/**
 * Marking read names the newest message the caller has seen, rather than
 * saying "everything".
 *
 * **Idempotent and order-independent by construction**: the server marks every
 * message the other party sent at or before that one, so a receipt that
 * arrives late, twice, or out of order can never un-read anything. "Mark
 * everything read" would have been a race with the message arriving while the
 * request was in flight — the reader would silently acknowledge something they
 * never saw.
 */
export const markMessagesReadSchema = z.object({ throughMessageId: z.uuid() }).strict();

export type OrderIdParams = z.infer<typeof orderIdParamsSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;
export type MarkMessagesReadRequest = z.infer<typeof markMessagesReadSchema>;
