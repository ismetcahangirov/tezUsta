import { z } from 'zod';

/**
 * The position a call listing resumes from: **the id of the last row the
 * previous page returned**, and nothing else (issue #186).
 *
 * `message-cursor.ts`'s shape, for `message-cursor.ts`'s reason. Carrying
 * `started_at` would round-trip a microsecond `timestamptz` through a
 * millisecond `Date`, and the truncated value sits *before* the row it names —
 * so a second call recorded in the same millisecond (a double-tapped invite
 * that met a busy line is exactly that) would fall between two pages. The
 * repository resolves `(started_at, id)` from the named row inside the query,
 * at the column's own precision.
 *
 * Opaque base64url so its shape can change without breaking a client that
 * stored one. It carries nothing the page did not already contain.
 */
const cursorPayloadSchema = z.object({ i: z.uuid() });

export function encodeCallCursor(callId: string): string {
  return Buffer.from(JSON.stringify({ i: callId }), 'utf8').toString('base64url');
}

/**
 * The call id a cursor names, or `null` for one that is not a cursor.
 *
 * **Never throws**: a cursor is attacker-controlled query-string input, and a
 * malformed one reads as "from the newest". A well-formed one naming a call
 * outside the listing matches no row in the repository's subquery, and the
 * page comes back empty — which says nothing about whether that id exists.
 */
export function decodeCallCursor(cursor: string | undefined): string | null {
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
