import { z } from 'zod';

/**
 * How many rows a catalogue page returns when the caller does not say.
 *
 * Fifty covers the whole launch catalogue in one request, so the app's first
 * screen is one round trip rather than two.
 */
export const DEFAULT_CATALOGUE_PAGE_SIZE = 50;

/**
 * The cap a caller cannot exceed. Without one, `?limit=1000000` is a request
 * that reads the whole table, serialises it, and does so on an endpoint that
 * needs no account — the cheapest denial-of-service in the API.
 */
export const MAX_CATALOGUE_PAGE_SIZE = 100;

/**
 * Query-string parsing for the catalogue listings.
 *
 * `z.coerce.number()` rather than `z.number()`: a query string is text, always.
 * `.catch()` is deliberately absent — a malformed `limit` is a 422 the client
 * can fix, not something to silently reinterpret. The cursor is the one
 * exception, and it is handled in `catalogue-cursor.ts` for the reason given
 * there.
 *
 * `.strict()` rejects an unknown query parameter instead of ignoring it. A
 * client that sends `?catagoryId=…` should be told, rather than quietly served
 * the unfiltered list and left to wonder why filtering "does not work".
 */
export const catalogueListQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CATALOGUE_PAGE_SIZE)
      .default(DEFAULT_CATALOGUE_PAGE_SIZE),
  })
  .strict();

export const serviceListQuerySchema = catalogueListQuerySchema.extend({
  categoryId: z.uuid().optional(),
});

export const serviceIdParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export type CatalogueListQuery = z.infer<typeof catalogueListQuerySchema>;
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;
export type ServiceIdParams = z.infer<typeof serviceIdParamsSchema>;
