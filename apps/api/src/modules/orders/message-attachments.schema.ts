import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../infra/storage/image-content-type';

/**
 * Validation for the message-photo endpoints (issue #181). Pre-`packages/validation`
 * code (ADR-0016): no Nest, Fastify or Drizzle type appears below.
 */

/**
 * **The same allow-list as order photos, from the same constant** — the three
 * types the magic-byte sniffer knows. ADR-0033 § 4 says nothing new is
 * invented here, and a second list is how the two would drift into a type
 * that is signable in one place and unrecognisable in the other.
 */
export const presignMessageAttachmentSchema = z
  .object({ contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES) })
  .strict();

export const messageAttachmentParamsSchema = z
  .object({ orderId: z.uuid(), attachmentId: z.uuid() })
  .strict();

export type PresignMessageAttachmentRequest = z.infer<typeof presignMessageAttachmentSchema>;
export type MessageAttachmentParams = z.infer<typeof messageAttachmentParamsSchema>;
