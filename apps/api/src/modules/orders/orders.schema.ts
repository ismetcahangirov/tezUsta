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

/**
 * How many orders a page returns when the caller does not say.
 *
 * Twenty is roughly two screens on a phone, which is what "the first render"
 * needs — an order list is scrolled, not read whole, so a bigger default would
 * be bytes nobody looks at on a mid-range Android device (CLAUDE.md §12).
 */
export const DEFAULT_ORDER_PAGE_SIZE = 20;

/**
 * The cap a caller cannot exceed. Without one, `?limit=1000000` reads a
 * customer's entire order history into memory and serialises it.
 */
export const MAX_ORDER_PAGE_SIZE = 50;

/**
 * Query-string parsing for `GET /orders`.
 *
 * `z.coerce.number()` rather than `z.number()`: a query string is text, always.
 * `.catch()` is deliberately absent — a malformed `limit` is a 422 the client
 * can fix. The cursor is the one exception, handled in `order-cursor.ts`.
 *
 * `.strict()` rejects an unknown query parameter rather than ignoring it: a
 * client that sends `?state=SEARCHING` should be told, not quietly served the
 * unfiltered list and left to wonder why filtering "does not work".
 */
export const listOrdersQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_ORDER_PAGE_SIZE).default(DEFAULT_ORDER_PAGE_SIZE),
    /**
     * `DRAFT` is deliberately absent from what a client may ask for. It is an
     * internal anchor for an in-flight creation, never shown, and accepting it
     * here would be offering a filter that can only ever return nothing.
     */
    status: z
      .enum([
        'SEARCHING',
        'ACCEPTED',
        'MASTER_ON_THE_WAY',
        'MASTER_ARRIVED',
        'IN_PROGRESS',
        'COMPLETED',
        'PAYMENT_PENDING',
        'PAID',
        'DISPUTED',
        'RESOLVED',
        'REFUNDED',
        'NO_MASTER_FOUND',
        'CANCELLED',
      ])
      .optional(),
  })
  .strict();

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/**
 * The statuses `POST /orders/:id/transitions` accepts as a target
 * (issues #134, #135, #136).
 *
 * **A subset of the transition table, not a second copy of it.** The table in
 * `order-lifecycle.ts` stays the authority on which edges exist and who may
 * walk them; this list says which of them *this route has been taught to
 * perform*, and the table is still asked on every request.
 *
 * The four `#134` added change the status and write one audit row and nothing
 * else. `CANCELLED` (#135) also closes the order's live offers, and
 * `SEARCHING` (#136) also clears the master, clears the frozen price and
 * counts against `MAX_ORDER_REDISPATCHES` — each in the transaction that
 * writes the status, because an order marked cancelled while a master's feed
 * still shows a live offer on it, or re-dispatched while still holding the
 * master the accept guard checks for, is an outcome that must never be
 * readable.
 *
 * `NO_MASTER_FOUND` is absent, and permanently: it is written as `system`,
 * either by the dispatch engine when a search times out or by the re-dispatch
 * cap. No client asks for it, and offering it here would be offering a way to
 * fake a supply signal (ADR-0015). `PAYMENT_PENDING`, `PAID`, `RESOLVED` and
 * `REFUNDED` wait for EPIC 12 and the admin dispute surface.
 */
export const TRANSITIONABLE_ORDER_STATUSES = [
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'SEARCHING',
] as const;

export type TransitionableOrderStatus = (typeof TRANSITIONABLE_ORDER_STATUSES)[number];

/**
 * The targets nobody may reach without saying why.
 *
 * Both take something away from somebody who was counting on it. A
 * cancellation ends an order a master may already be driving to, and it is
 * terminal, so the trail row is the only account of it there will ever be. A
 * re-dispatch drops a job a customer is waiting on, and a master who does that
 * owes a record of why.
 *
 * A list rather than a `.refine()` per target so that the rule is readable as
 * data: adding a target above and forgetting it here is a visible omission,
 * not an invisible one.
 */
export const REASONED_TRANSITION_TARGETS: readonly TransitionableOrderStatus[] = [
  'CANCELLED',
  'SEARCHING',
];

/**
 * The longest reason the trail can hold — `order_status_history_reason_length`
 * bounds it at the database, and this is what turns that check constraint into
 * a 422 at the boundary rather than a 500 from a failed insert.
 */
export const MAX_TRANSITION_REASON_LENGTH = 600;

/**
 * The reason field, in the one shape every transition surface uses.
 *
 * `.trim()` before the bounds, so a body of three spaces is a 422 here rather
 * than a check-constraint violation and a 500 at the insert —
 * `order_status_history_reason_length` measures `btrim(reason)` and this must
 * measure the same string.
 */
export const transitionReasonSchema = z.string().trim().min(1).max(MAX_TRANSITION_REASON_LENGTH);

/**
 * **Mandatory where it matters, and mandatory at the boundary.**
 *
 * A `reason` that is required by a comment is a `reason` that arrives null on
 * the first client that forgets it, and `order_status_history` is append-only:
 * there is no second chance to record why an order was cancelled. Zod is what
 * makes the requirement true (issue #135).
 *
 * Expressed as a refinement on the whole object rather than as a discriminated
 * union on `to`, so that the error the client gets is still *about the reason
 * field* — `path: ['reason']` — instead of "no union member matched", which
 * tells an app nothing it can render next to an input.
 */
export const transitionOrderSchema = z
  .object({
    to: z.enum(TRANSITIONABLE_ORDER_STATUSES),
    /**
     * Optional on the four advancing edges, which nobody has to justify, and
     * required on the targets in {@link REASONED_TRANSITION_TARGETS}.
     */
    reason: transitionReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reason === undefined && REASONED_TRANSITION_TARGETS.includes(value.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is required for this transition.',
      });
    }
  });

export type TransitionOrderRequest = z.infer<typeof transitionOrderSchema>;

export const orderIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
