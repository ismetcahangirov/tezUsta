import { z } from 'zod';

/** The widest page an admin list will serve. */
export const MAX_PAGE_SIZE = 100;

/**
 * A reason an admin writes, which the **master reads**
 * ([ADR-0023](docs/decisions/ADR-0023-master-verification-policy.md)).
 *
 * Required on every negative outcome, and bounded at both ends: an empty
 * reason is not a reason, and the database CHECK caps it at 600 characters.
 * Because it is shown to the master, it must never carry an internal note —
 * that is a rule about what an admin writes, not something a schema can
 * enforce, and it is why the field is documented here rather than only in the
 * ADR.
 */
const reason = z.string().trim().min(1).max(600);

export const masterIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const masterDocumentParamsSchema = z.object({ id: z.uuid(), documentId: z.uuid() }).strict();

export const listMastersQuerySchema = z
  .object({
    status: z
      .enum(['pending_verification', 'changes_requested', 'rejected', 'active', 'suspended'])
      .optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .strict();

/** `verify` and `reinstate` take no body — there is nothing to explain. */
export const reasonlessActionSchema = z.object({}).strict();

/** `reject`, `request-more` and `suspend` all require one. */
export const reasonedActionSchema = z.object({ reason }).strict();

export type ListMastersQuery = z.infer<typeof listMastersQuerySchema>;
export type MasterIdParams = z.infer<typeof masterIdParamsSchema>;
export type MasterDocumentParams = z.infer<typeof masterDocumentParamsSchema>;
export type ReasonedActionRequest = z.infer<typeof reasonedActionSchema>;
