import { z } from 'zod';

/**
 * Admin catalogue writes (issue #244). Every rule the database enforces is
 * checked here first, so a bad edit is a 422 naming the field rather than a
 * constraint violation: slug format, an `az` name, and the pricing shape.
 */
const slug = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case letters, digits and single hyphens');

/** `{ az: '…', en?: '…', ru?: '…' }` — `az` is the fallback every reader relies on. */
const localizedName = z
  .record(z.string().regex(/^[a-z]{2}$/), z.string().trim().min(1).max(80))
  .refine((value) => typeof value.az === 'string' && value.az.length > 0, {
    message: 'An Azerbaijani name (`az`) is required.',
  })
  .refine((value) => Object.keys(value).length <= 5, { message: 'At most five languages.' })
  .transform((value) => value as { az: string } & Record<string, string>);

const displayOrder = z.number().int().min(0).max(1_000_000);
/** Minor units (qəpik). The ceiling is a typo guard: 100 000 AZN. */
const basePriceMinor = z.number().int().min(1).max(10_000_000);
const pricingKind = z.enum(['fixed', 'inspection']);

export const catalogueIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const createCategorySchema = z
  .object({
    slug,
    name: localizedName,
    displayOrder: displayOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updateCategorySchema = createCategorySchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' });

export const createServiceSchema = z
  .object({
    categoryId: z.uuid(),
    slug,
    name: localizedName,
    pricingKind,
    basePriceMinor: basePriceMinor.nullable().optional(),
    displayOrder: displayOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.pricingKind === 'inspection'
        ? value.basePriceMinor === undefined || value.basePriceMinor === null
        : typeof value.basePriceMinor === 'number',
    {
      message: 'A fixed-price service needs a reference price; an inspection service has none.',
      path: ['basePriceMinor'],
    },
  );

export const updateServiceSchema = z
  .object({
    categoryId: z.uuid(),
    slug,
    name: localizedName,
    pricingKind,
    basePriceMinor: basePriceMinor.nullable(),
    displayOrder,
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' });

export const reorderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict();
