import { z } from 'zod';

/**
 * Validation for inbound socket messages (issue #167).
 *
 * **A socket message is untrusted input, exactly as an HTTP body is**
 * (CLAUDE.md §11, `realtime-architecture.md` § Security). The one difference
 * is what a failure costs: an unparsable HTTP body is one 422 and the
 * connection is over, while an unparsable socket frame arrives on a live
 * connection that may be carrying a legitimate order. So a rejection here
 * answers the message and leaves the socket up — "rejected without
 * disconnecting the world".
 *
 * Pre-`packages/validation` code (ADR-0016): no Nest, socket.io or Drizzle type
 * appears below.
 */

/**
 * `.strict()` on both members, so an unknown key is a rejection rather than
 * something silently dropped. A client sending `{ kind: 'order', orderId,
 * masterId }` is either confused about the contract or probing it, and neither
 * deserves a success.
 */
export const roomRequestSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('order'), orderId: z.uuid() }).strict(),
    z.object({ kind: z.literal('master'), masterId: z.uuid() }).strict(),
  ])
  .readonly();

export type RoomRequestInput = z.infer<typeof roomRequestSchema>;

/**
 * `conversation:typing` (issue #179). Strict for the reason above: the frame
 * says one thing, and a client that sends more is confused or probing.
 */
export const typingRequestSchema = z.object({ orderId: z.uuid() }).strict().readonly();

export type TypingRequestInput = z.infer<typeof typingRequestSchema>;
