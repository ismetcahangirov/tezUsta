import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../infra/storage/image-content-type';

/**
 * Validation for the order-photo endpoints (issue #83), the exact same shape
 * `master-verification.schema.ts` uses for documents. Pre-`packages/validation`
 * code (ADR-0016): no Nest, Fastify or Drizzle type appears below.
 */

/**
 * **An allow-list, not a deny-list.** The same three content types the
 * magic-byte sniffer knows, from the same constant `master-verification.schema.ts`
 * uses, so the two can never drift into a state where a type is signable but
 * unrecognisable.
 */
export const presignOrderPhotoSchema = z
  .object({ contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES) })
  .strict();

export const photoIdParamsSchema = z.object({ photoId: z.uuid() }).strict();

export const orderIdParamsSchema = z.object({ orderId: z.uuid() }).strict();

export const orderPhotoParamsSchema = z.object({ orderId: z.uuid(), photoId: z.uuid() }).strict();

/**
 * The attach body names the photo by id, never by storage key — a client
 * never sees a storage key at all (`order-photos.service.ts` § "Keys are
 * server-generated").
 */
export const attachOrderPhotoSchema = z.object({ photoId: z.uuid() }).strict();

export type PresignOrderPhotoRequest = z.infer<typeof presignOrderPhotoSchema>;
export type PhotoIdParams = z.infer<typeof photoIdParamsSchema>;
export type OrderIdParams = z.infer<typeof orderIdParamsSchema>;
export type OrderPhotoParams = z.infer<typeof orderPhotoParamsSchema>;
export type AttachOrderPhotoRequest = z.infer<typeof attachOrderPhotoSchema>;
