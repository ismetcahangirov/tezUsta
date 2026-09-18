import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../infra/storage/image-content-type';

/**
 * The three document types, restated as a Zod enum.
 *
 * Deliberately a literal list rather than something derived from the Drizzle
 * `pgEnum`: this file is pre-`packages/validation` code (ADR-0016) and must
 * not import a database type, or the eventual extraction stops being a file
 * move. The database enum is the authority; this is the boundary check, and
 * `master-verification.e2e.test.ts` is what keeps the two in step.
 */
export const documentTypeSchema = z.enum(['id_card_front', 'id_card_back', 'selfie_with_id']);

/**
 * **An allow-list, not a deny-list** — an allow-list fails closed
 * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)). The same three
 * types the magic-byte sniffer knows, from the same constant, so the two can
 * never drift into a state where a type is signable but unrecognisable.
 */
export const presignDocumentSchema = z
  .object({
    documentType: documentTypeSchema,
    contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES),
  })
  .strict();

export const documentIdParamsSchema = z.object({ id: z.uuid() }).strict();

export type PresignDocumentRequest = z.infer<typeof presignDocumentSchema>;
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;
