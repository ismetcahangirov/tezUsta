import { z } from 'zod';

/**
 * The position the master's post list resumes from: the id of the last post
 * the previous page returned. `call-cursor.ts`'s shape, for its reason — the
 * repository reads `(created_at, id)` from that row at the column's own
 * precision, so two posts made in the same millisecond never fall between
 * pages.
 */
const cursorPayloadSchema = z.object({ p: z.uuid() });

export function encodePortfolioCursor(postId: string): string {
  return Buffer.from(JSON.stringify({ p: postId }), 'utf8').toString('base64url');
}

/** The post id a cursor names, or `null` for one that is not a cursor. Never throws. */
export function decodePortfolioCursor(cursor: string | undefined): string | null {
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
  return result.success ? result.data.p : null;
}
