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

/**
 * The position the admin's post list (#312) resumes from: the last post's
 * `(created_at, id)` itself, `created_at` at the column's microsecond
 * precision. Unlike the master's own list it cannot name a row to read the
 * pair from: this list shows drafts and deleted posts, which are hard-deleted
 * within seconds or days, and a cursor naming one that is gone must still
 * resume where it left off rather than start again.
 */
export interface AdminPortfolioPosition {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, as Postgres printed it. */
  readonly createdAt: string;
  readonly id: string;
}

const adminCursorSchema = z.object({
  t: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    .refine((value) => !Number.isNaN(Date.parse(value))),
  i: z.uuid(),
});

export function encodeAdminPortfolioCursor(position: AdminPortfolioPosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt, i: position.id }), 'utf8').toString(
    'base64url',
  );
}

/** The position a cursor names, or `null` for one that is not a cursor. Never throws. */
export function decodeAdminPortfolioCursor(
  cursor: string | undefined,
): AdminPortfolioPosition | null {
  if (cursor === undefined || cursor === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const result = adminCursorSchema.safeParse(parsed);
  return result.success ? { createdAt: result.data.t, id: result.data.i } : null;
}
