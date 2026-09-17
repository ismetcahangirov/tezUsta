import { z } from 'zod';

/**
 * Validation for the geocoding endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no Fastify
 * type and no Drizzle type appears below.
 */

/** The same bound `addresses.formatted_address` carries — they are the same text. */
export const MAX_GEOCODE_QUERY_LENGTH = 300;

/**
 * `.strict()` and bounded, because this body is the argument to a **billable**
 * upstream call. An unbounded string here is a request that costs money to
 * reject (`docs/engineering/security.md`: "bound every string").
 */
export const forwardGeocodeSchema = z
  .object({
    address: z.string().trim().min(1).max(MAX_GEOCODE_QUERY_LENGTH),
  })
  .strict();

export const reverseGeocodeSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

export type ForwardGeocodeRequest = z.infer<typeof forwardGeocodeSchema>;
export type ReverseGeocodeRequest = z.infer<typeof reverseGeocodeSchema>;
