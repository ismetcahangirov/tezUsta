import { z } from 'zod';

/**
 * The opaque cursor for `GET /me/reviews/received` (issue #225): the id of the
 * last review on the page, and nothing else.
 *
 * **The id, not its timestamp**, for the reason `message-cursor.ts` gives: a
 * `timestamptz` holds microseconds and a `Date` milliseconds, so a cursor that
 * carried `revealed_at` would truncate it and skip rows revealed in the same
 * millisecond. The position is resolved in SQL from the row the id names.
 *
 * A malformed cursor reads as "from the start" rather than an error — it is
 * opaque, and a client cannot build a meaningful one by hand.
 */
const cursorPayloadSchema = z.object({ i: z.uuid() });

export function encodeReviewCursor(reviewId: string): string {
  return Buffer.from(JSON.stringify({ i: reviewId }), 'utf8').toString('base64url');
}

export function decodeReviewCursor(cursor: string | undefined): string | null {
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
