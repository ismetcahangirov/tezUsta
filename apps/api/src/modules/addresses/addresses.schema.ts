import { z } from 'zod';

/**
 * Validation for the saved-address endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no Fastify
 * type and no Drizzle type appears below, so the day `apps/mobile` reuses these
 * shapes the move to `packages/validation` is a file move rather than a
 * rewrite.
 */

/** Enough for a full one-line Baku address; a bound, because every string gets one. */
export const MAX_FORMATTED_ADDRESS_LENGTH = 300;
export const MAX_LANDMARK_NOTE_LENGTH = 300;
/** `label`, `building`, `entrance`, `floor`, `apartment` — all short by nature. */
export const MAX_ADDRESS_DETAIL_LENGTH = 40;

/**
 * How many live addresses one customer may keep.
 *
 * **This is an abuse guard, not a product rule.** `GET /addresses` returns a
 * plain array rather than a page, which is right for the handful of addresses a
 * real customer saves and wrong for an account that inserts a hundred thousand;
 * the cap is what keeps the unpaginated response honest. Fifty is deliberately
 * far above any plausible use — a customer with a home, an office, a parents'
 * flat and a summer house is at four — so it never argues with a real person.
 *
 * If the owner wants a different number, or wants the limit to mean something
 * (a paid tier, say), that is a product decision and this constant is the one
 * place it lands.
 */
export const MAX_SAVED_ADDRESSES = 50;

const detail = z.string().trim().min(1).max(MAX_ADDRESS_DETAIL_LENGTH);
const formattedAddress = z.string().trim().min(1).max(MAX_FORMATTED_ADDRESS_LENGTH);
const landmarkNote = z.string().trim().min(1).max(MAX_LANDMARK_NOTE_LENGTH);

/**
 * WGS 84 degrees, bounded to the planet.
 *
 * Not bounded to Azerbaijan, deliberately. A box around the country is a
 * product decision nobody has made, it would reject a legitimate address on the
 * border, and the failure it is imagined to catch — latitude and longitude
 * swapped — is invisible to it anyway: in Baku both numbers (≈40.4 and ≈49.9)
 * sit inside each other's range. The swap is caught by a round-trip test that
 * asserts `ST_X` is the longitude, which is where a coordinate-ordering bug
 * actually shows up.
 */
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/**
 * `.strict()` so an unknown key is a 422 rather than a silently dropped field.
 * A client that sends `enterance` should be told, not left wondering why the
 * master could not find the entrance.
 */
export const createAddressSchema = z
  .object({
    label: detail.optional(),
    formattedAddress,
    building: detail.optional(),
    entrance: detail.optional(),
    floor: detail.optional(),
    apartment: detail.optional(),
    landmarkNote: landmarkNote.optional(),
    latitude,
    longitude,
    isDefault: z.boolean().optional(),
  })
  .strict();

/**
 * Every field optional, but not the object — an empty `PATCH` would answer 200
 * with an unchanged address, which reads to a client as "your edit was
 * applied". It was not.
 *
 * The nullable fields accept an explicit `null` to **clear** them, which is a
 * different request from omitting them: a customer who typed the wrong
 * apartment number needs a way to remove it, and without `null` the only way
 * out is to delete the address and retype it. `formattedAddress`, the
 * coordinates and `isDefault` are not nullable, because an address with no line
 * of text and no position is not an address.
 */
export const updateAddressSchema = z
  .object({
    label: detail.nullable().optional(),
    formattedAddress: formattedAddress.optional(),
    building: detail.nullable().optional(),
    entrance: detail.nullable().optional(),
    floor: detail.nullable().optional(),
    apartment: detail.nullable().optional(),
    landmarkNote: landmarkNote.nullable().optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  })
  /**
   * Latitude and longitude move together or not at all. Accepting one alone
   * would let a client shift a pin a thousand kilometres by correcting what it
   * thought was a typo, and the resulting point would still pass every bound
   * check because both halves are individually valid.
   */
  .refine((patch) => (patch.latitude === undefined) === (patch.longitude === undefined), {
    message: 'Provide latitude and longitude together, or neither.',
  });

export const addressIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type CreateAddressRequest = z.infer<typeof createAddressSchema>;
export type UpdateAddressRequest = z.infer<typeof updateAddressSchema>;
export type AddressIdParams = z.infer<typeof addressIdParamsSchema>;
