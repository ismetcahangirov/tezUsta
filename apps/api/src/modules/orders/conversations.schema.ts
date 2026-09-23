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
 * The most photos one message may carry (issue #181).
 *
 * Four is what fits one row of thumbnails on a phone and covers the real case
 * — before, after, the part, the label on it. It is also the bound on how many
 * presigned GETs one message costs every time a history page is read, which is
 * the number that actually matters to the server: a page of thirty messages is
 * at most a hundred and twenty signatures, all computed locally with no round
 * trip, rather than an unbounded amount of work chosen by whoever sent them.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/**
 * **A message is text, photos, or both — never neither** (issue #181).
 *
 * `body` defaults to the empty string so a photo can be sent on its own, and
 * the refinement is what still refuses a message with nothing in it. The empty
 * body is the one the `messages_body_shape` CHECK admits; a body of spaces is
 * still refused, by the `trim()` here turning it into the empty string and the
 * refinement then finding no photo to justify it. Trimming also keeps the
 * request bound and the column's `length(btrim(...))` CHECK measuring the same
 * string, so a body that passes Zod cannot then be refused by Postgres as a
 * 500.
 *
 * `attachmentIds` must be distinct: naming one photo twice is a client bug,
 * and answering it with a message carrying the photo once would be a guess
 * about what was meant.
 */
export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(MAX_MESSAGE_BODY_LENGTH).default(''),
    attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  })
  .strict()
  .refine((value) => value.body.length > 0 || value.attachmentIds.length > 0, {
    message: 'A message needs text, at least one photo, or both.',
    path: ['body'],
  })
  .refine((value) => new Set(value.attachmentIds).size === value.attachmentIds.length, {
    message: 'Each photo may be named once.',
    path: ['attachmentIds'],
  });

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
