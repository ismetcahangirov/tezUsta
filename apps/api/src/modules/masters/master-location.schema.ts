import { z } from 'zod';

/**
 * WGS 84 degrees, bounded to the planet — the same pair `addresses.schema.ts`
 * declares, and deliberately not bounded to Azerbaijan for the same reasons: a
 * box around the country is a product decision nobody has made, and the bug it
 * is imagined to catch (latitude and longitude swapped) is invisible to it
 * anyway, because in Baku ≈40.4 and ≈49.9 sit inside each other's range.
 *
 * The swap is caught instead by a round-trip test asserting `ST_X` is the
 * longitude, and the bounds are restated in the database as
 * `master_locations_position_on_earth` so a seed script or an admin tool
 * cannot get past them either.
 */
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/**
 * `.strict()`, so a client that invents `lat`, `lng`, `accuracy` or `heading`
 * is told rather than having the field silently dropped. That matters more
 * here than on most bodies: a master's app that thinks it is sending accuracy
 * and is not would look identical to one that is, and the first symptom would
 * be a dispatch decision made on a position nobody could explain.
 *
 * `z.number()` and not a coercion. A string `"40.4"` from a client that
 * stringified its payload is a bug in that client, and coercing it would hide
 * the day it starts sending `"40,4"` instead.
 */
export const reportLocationSchema = z.object({ latitude, longitude }).strict();

export type ReportLocationRequest = z.infer<typeof reportLocationSchema>;
