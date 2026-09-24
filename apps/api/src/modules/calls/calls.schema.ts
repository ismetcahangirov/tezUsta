import { z } from 'zod';

/**
 * Validation for the call frames and for the ring-timeout job (issue #185).
 *
 * **A socket frame is untrusted input, exactly as an HTTP body is**
 * (`realtime/realtime.schema.ts`), and a job payload has been through Redis
 * and is no more trusted than either (`dispatch/dispatch.schema.ts`). Every
 * schema here is `.strict()`: a frame that says more than its contract is a
 * client confused about the contract or probing it.
 *
 * **`call:invite` carries the order and nothing else.** No callee, no room:
 * the callee is whoever the other party to that order currently is, and the
 * room is derived from the call id — so there is no field a client could fill
 * with somebody else's id.
 */
export const callInviteRequestSchema = z.object({ orderId: z.uuid() }).strict().readonly();

/** `call:accept`, `call:reject`, `call:cancel`, `call:hangup`. */
export const callActionRequestSchema = z.object({ callId: z.uuid() }).strict().readonly();

/** `POST /calls/:callId/join`. */
export const callIdParamsSchema = z.object({ callId: z.uuid() }).strict();

/**
 * The ring-timeout job. **An id, never the call** — by the time it runs the
 * call has usually been answered, declined or cancelled, and the handler
 * re-reads it (`backend-architecture.md` § Background jobs).
 */
export const callRingTimeoutPayloadSchema = z.object({ callId: z.uuid() }).strict();

export type CallInviteInput = z.infer<typeof callInviteRequestSchema>;
export type CallActionInput = z.infer<typeof callActionRequestSchema>;

/**
 * The most call records one page returns, and the default (issue #186). An
 * order carries a handful of calls; the ceiling is what stops one request
 * asking for a whole table's worth of admin history.
 */
export const MAX_CALL_PAGE_SIZE = 100;
export const DEFAULT_CALL_PAGE_SIZE = 25;

export const callPageLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_CALL_PAGE_SIZE)
  .default(DEFAULT_CALL_PAGE_SIZE);

/** The opaque cursor from the previous page (`call-cursor.ts`); bounded, never trusted. */
export const callCursor = z.string().max(512).optional();

/** `GET /orders/:orderId/calls`. */
export const callHistoryParamsSchema = z.object({ orderId: z.uuid() }).strict();

export const listCallHistoryQuerySchema = z
  .object({ cursor: callCursor, limit: callPageLimit })
  .strict();
