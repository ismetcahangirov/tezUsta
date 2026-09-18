import { z } from 'zod';

/** Mirrors the `masters_display_name_length` CHECK, so both ends agree. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/** Mirrors the `masters_bio_length` CHECK. */
export const MAX_BIO_LENGTH = 600;

/**
 * An arithmetic ceiling, **not a commercial guardrail.**
 *
 * 100 000 000 minor units is one million AZN, far above anything a household
 * repair could cost, and comfortably inside the `bigint … mode: 'number'`
 * column's safe-integer range. Its job is to stop a client from posting a
 * number that would round when it crosses JSON, not to express an opinion
 * about what a master may charge — minimum and maximum price guardrails are an
 * open business decision
 * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)), and putting
 * a made-up figure here would be engineering deciding one.
 */
export const MAX_PRICE_MINOR = 100_000_000;

const displayName = z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH);

/**
 * `.trim()` before the length check, so 600 spaces is an empty bio rather than
 * a full one. A bio that trims to nothing is rejected instead of stored as a
 * blank string — "no bio" already has a representation, and it is `null`.
 */
const bio = z.string().trim().min(1).max(MAX_BIO_LENGTH);

/**
 * `priceMinor` is integer minor units. `.int()` rather than a rounding step:
 * 1500.5 is not 15.005 AZN, it is a client bug, and the honest answer to a bug
 * is 422 rather than a silently different price than the one the master typed.
 */
const priceMinor = z.int().positive().max(MAX_PRICE_MINOR);

export const createMasterSchema = z
  .object({
    displayName,
    bio: bio.optional(),
  })
  .strict();

export const updateMasterSchema = z
  .object({
    displayName: displayName.optional(),
    /**
     * `.nullable()` is the way a master clears their bio. Omitting the key
     * leaves it alone; sending `null` erases it. Without the distinction there
     * would be no request that means "remove this".
     */
    bio: bio.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const masterIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const masterServiceParamsSchema = z.object({ serviceId: z.uuid() }).strict();

export const addMasterServiceSchema = z
  .object({
    serviceId: z.uuid(),
    /**
     * Absent for an inspection-priced service and required for a fixed-price
     * one — but which of those this service is lives on the catalogue row, so
     * the pairing cannot be checked here. `MastersService` reads the service
     * and enforces it there, where the answer is knowable.
     */
    priceMinor: priceMinor.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updateMasterServiceSchema = z
  .object({
    /** `null` clears the price; omitted leaves it. See `bio` above. */
    priceMinor: priceMinor.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type CreateMasterRequest = z.infer<typeof createMasterSchema>;
export type UpdateMasterRequest = z.infer<typeof updateMasterSchema>;
export type MasterIdParams = z.infer<typeof masterIdParamsSchema>;
export type MasterServiceParams = z.infer<typeof masterServiceParamsSchema>;
export type AddMasterServiceRequest = z.infer<typeof addMasterServiceSchema>;
export type UpdateMasterServiceRequest = z.infer<typeof updateMasterServiceSchema>;
