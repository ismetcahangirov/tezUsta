import { z } from 'zod';

/**
 * Validation for the customer-profile endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest type, no Fastify
 * type and no Drizzle type appears below, so the day `apps/mobile` reuses
 * these shapes the move to `packages/validation` is a file move rather than a
 * rewrite.
 */

/**
 * Long enough for a full Azerbaijani name with patronymic, short enough that
 * the column is not a free text field with extra steps
 * (`docs/engineering/security.md`: "bound every string"). The same bound is
 * restated as a CHECK on the table, because validation only runs on the
 * request path and a seed or an admin tool does not take that path.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * `.trim()` runs **before** the length check, so " " is one character that
 * becomes zero and is rejected, rather than a name that passes validation and
 * then trips the database CHECK as a 500. Trimming on the way in also means
 * the stored value is the one that was meant: a trailing space copied out of a
 * contacts app is not a different person.
 */
const displayName = z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH);

/**
 * `.strict()` throughout, and that is doing real work here rather than being
 * tidy: `avatarKey` is a column on this table, and a lenient schema would let
 * a client post one and have it silently ignored today — right up until
 * somebody wires the field through and the ignored value becomes an accepted
 * one. A client must never name its own storage key
 * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md): "Keys are
 * server-generated UUIDs, never client-supplied filenames"), so the request
 * that tries is refused now, loudly, while refusing it costs nothing.
 */
export const createCustomerSchema = z.object({ displayName }).strict();

/**
 * Every field optional — but not the object.
 *
 * A `PATCH` with an empty body is a request that says nothing and would
 * otherwise return 200 with an unchanged profile, which reads to a client as
 * "your edit was applied". It was not. `.refine` turns that into the 422 it
 * is, and the message names the fix rather than the rule.
 */
export const updateCustomerSchema = z
  .object({ displayName: displayName.optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const customerIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type CreateCustomerRequest = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerRequest = z.infer<typeof updateCustomerSchema>;
export type CustomerIdParams = z.infer<typeof customerIdParamsSchema>;
