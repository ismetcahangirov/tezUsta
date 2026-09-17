import { z } from 'zod';

/**
 * The position a catalogue listing resumes from: the `(display_order, id)` pair
 * of the last row the previous page returned.
 *
 * Both halves are needed. `display_order` alone is not unique — two services
 * may deliberately share an order — so a cursor carrying only it would either
 * skip rows or repeat them at every tie. `id` breaks the tie, and because ids
 * are UUIDv7 the tiebreak is insertion order rather than something arbitrary.
 */
export interface CataloguePosition {
  readonly displayOrder: number;
  readonly id: string;
}

const cursorPayloadSchema = z.object({
  o: z.int(),
  i: z.uuid(),
});

/**
 * **Cursor pagination, not offset** (`docs/architecture/backend-architecture.md`
 * § API conventions). `OFFSET 40` is defined against a result set that shifts
 * whenever a row is inserted or deactivated above it, so a client paging
 * through silently skips or repeats rows. A keyset cursor is defined against a
 * row, and keeps meaning the same thing.
 *
 * The encoding is base64url of a tiny JSON object, which makes it **opaque by
 * convention rather than by secrecy** — it is trivially decodable and that is
 * fine, because it carries only a sort position and an id the response already
 * contains. It is encoded rather than exposed as two query parameters so the
 * pagination key can change shape later without breaking a client that stored
 * one, and so nobody builds a client that arithmetically increments it.
 */
export function encodeCatalogueCursor(position: CataloguePosition): string {
  return Buffer.from(JSON.stringify({ o: position.displayOrder, i: position.id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Returns the position a cursor names, or `null` when the string is not one.
 *
 * **Never throws.** A cursor arrives in a query string on a public endpoint, so
 * it is attacker-controlled input: a malformed one must not be able to 500 the
 * catalogue, and it must not be distinguishable from an absent one in any way
 * that rewards probing. The caller treats `null` as "start from the beginning",
 * which is the same thing an absent cursor means.
 */
export function decodeCatalogueCursor(cursor: string | undefined): CataloguePosition | null {
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

  return { displayOrder: result.data.o, id: result.data.i };
}
