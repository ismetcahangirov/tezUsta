import { z } from 'zod';

/**
 * The position a message listing resumes from, carried as **the id of the last
 * row the previous page returned** and nothing else.
 *
 * **This deliberately differs from `order-cursor.ts`, which carries
 * `(created_at, id)`, and the difference is a correctness fix rather than a
 * preference.** A `timestamptz` holds microseconds; a JavaScript `Date` holds
 * milliseconds. Round-tripping a timestamp through a cursor therefore truncates
 * it, and the truncated value sits *before* the row it names — so a row written
 * in the same millisecond but a few microseconds earlier satisfies neither
 * `created_at < cursor` nor `created_at = cursor`, and is silently dropped from
 * every page after the first.
 *
 * Two messages inside one millisecond is not a thought experiment on this
 * surface: it is one party tapping send twice, or a client flushing a queued
 * message the instant a socket reconnects. So the timestamp is not carried at
 * all. The repository resolves `(created_at, id)` from the named row inside the
 * query, with a subquery scoped to the same conversation, and the comparison
 * happens entirely in Postgres at the column's own precision.
 *
 * (`order-cursor.ts` has the same latent flaw and is left alone: orders are not
 * created several-per-millisecond by one customer, and fixing it there is a
 * change to a paginated contract that this issue was not asked to make.)
 *
 * The cursor stays opaque base64url for the reasons that file gives — so it can
 * change shape later without breaking a client that stored one, and so nobody
 * increments it arithmetically. It carries nothing the response did not already
 * contain.
 */
const cursorPayloadSchema = z.object({ i: z.uuid() });

export function encodeMessageCursor(messageId: string): string {
  return Buffer.from(JSON.stringify({ i: messageId }), 'utf8').toString('base64url');
}

/**
 * Returns the message id a cursor names, or `null` when the string is not one.
 *
 * **Never throws.** A cursor is attacker-controlled input arriving in a query
 * string; a malformed one must be indistinguishable from an absent one, which
 * the caller reads as "start from the newest message".
 *
 * A *well-formed* cursor naming a message that is not in this conversation is a
 * different case and is not handled here: the repository's subquery finds no
 * row, the comparison is `NULL`, and the page comes back empty. That is the
 * right answer — it reveals nothing about whether the id exists elsewhere,
 * which a 404 would.
 */
export function decodeMessageCursor(cursor: string | undefined): string | null {
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
  return result.success ? result.data.i : null;
}
