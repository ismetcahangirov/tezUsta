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
 * The statuses `POST /orders/:id/transitions` accepts as a target today
 * (issue #134).
 *
 * **A subset of the transition table, not a second copy of it.** The table in
 * `order-lifecycle.ts` stays the authority on which edges exist and who may
 * walk them; this list says which of them *this route has been taught to
 * perform*. The four here change the status and write one audit row, and
 * nothing else.
 *
 * The edges deliberately missing are the ones with side effects nobody has
 * implemented yet: `CANCELLED` must close the order's live offers in the same
 * transaction, and `SEARCHING` must clear the master and the frozen price and
 * count against the re-dispatch cap. Accepting either here would perform half
 * a transition — an order marked cancelled while a master's feed still shows
 * it as live — which is worse than refusing one. They widen this list when
 * their own issues land.
 */
export const ADVANCEABLE_ORDER_STATUSES = [
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
] as const;

/**
 * The longest reason the trail can hold — `order_status_history_reason_length`
 * bounds it at the database, and this is what turns that check constraint into
 * a 422 at the boundary rather than a 500 from a failed insert.
 */
export const MAX_TRANSITION_REASON_LENGTH = 600;

export const transitionOrderSchema = z
  .object({
    to: z.enum(ADVANCEABLE_ORDER_STATUSES),
    /**
     * Optional for these four edges, which nobody has to justify, and present
     * anyway: cancellation and admin override make it mandatory, and adding a
     * field later to a request shape the app already sends is a migration of
     * two codebases rather than one.
     */
    reason: z.string().trim().min(1).max(MAX_TRANSITION_REASON_LENGTH).optional(),
  })
  .strict();

export type TransitionOrderRequest = z.infer<typeof transitionOrderSchema>;

export const orderIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
