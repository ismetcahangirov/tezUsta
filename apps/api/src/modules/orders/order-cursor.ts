import { z } from 'zod';

/**
 * The position an order listing resumes from: the `(created_at, id)` pair of
 * the last row the previous page returned.
 *
 * Both halves are needed. Two orders created in the same millisecond are not
 * hypothetical — a retry storm produces exactly that — and a cursor carrying
 * only the timestamp would skip or repeat them. `id` breaks the tie, and
 * because ids are UUIDv7 the tiebreak agrees with creation order rather than
 * being arbitrary.
 */
export interface OrderPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Milliseconds since the epoch, bounded to what `Date` can actually represent.
 *
 * Without the bound a cursor naming `1e18` would pass validation, become an
 * `Invalid Date`, and reach Postgres as `NaN` — a 500 built out of a query
 * string. The bound is what keeps a malformed cursor indistinguishable from an
 * absent one.
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const cursorPayloadSchema = z.object({
  t: z.int().min(-MAX_TIMESTAMP_MS).max(MAX_TIMESTAMP_MS),
  i: z.uuid(),
});

/**
 * **Cursor pagination, not offset** (`docs/architecture/backend-architecture.md`
 * § API conventions). An order list is the one place where offset would break
 * most visibly: a customer creates an order, the list shifts by one, and the
 * second page repeats a row the first page already showed.
 *
 * Encoded base64url for the reasons `catalogue-cursor.ts` gives — opaque by
 * convention rather than by secrecy, so the key can change shape later without
 * breaking a client that stored one, and so nobody increments it arithmetically.
 * It carries nothing the response does not already contain.
 */
export function encodeOrderCursor(position: OrderPosition): string {
  return Buffer.from(
    JSON.stringify({ t: position.createdAt.getTime(), i: position.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Returns the position a cursor names, or `null` when the string is not one.
 *
 * **Never throws.** A cursor is attacker-controlled input arriving in a query
 * string; a malformed one must be indistinguishable from an absent one, which
 * the caller reads as "start from the beginning".
 */
export function decodeOrderCursor(cursor: string | undefined): OrderPosition | null {
  if (cursor === undefined || cursor === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return { createdAt: new Date(result.data.t), id: result.data.i };
}
