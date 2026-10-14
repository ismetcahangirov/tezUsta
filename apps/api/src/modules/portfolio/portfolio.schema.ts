import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../infra/storage/image-content-type';

/**
 * Validation for the master's own portfolio (#308). Pre-`packages/validation`
 * code (ADR-0016): no Nest, Fastify or Drizzle type appears below.
 *
 * Bounds that come from configuration — the caption's length, how many photos
 * a post holds — are checked again in the service against `AppConfig`. The
 * numbers here are the hard ceilings the database's CHECKs also hold, so a
 * body that could never be valid is refused before anything reads config.
 */

/** A caption: trimmed, and an empty one is no caption. `null` clears it on an edit. */
const captionSchema = z
  .string()
  .max(2_000)
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

export const createPortfolioPostSchema = z
  .object({
    caption: captionSchema.optional(),
    serviceId: z.uuid().nullable().optional(),
  })
  .strict();

export const updatePortfolioPostSchema = z
  .object({
    caption: captionSchema.optional(),
    serviceId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => body.caption !== undefined || body.serviceId !== undefined, {
    message: 'Send a caption or a serviceId to change.',
  });

/**
 * One photo's presign. **Images only**: ADR-0045 § 7 defers video, so there
 * is no `kind`, and no `video/*` type is on the allow-list. `.strict()`
 * refuses a `kind` field rather than ignoring it, so a client built for video
 * learns at once that the server is not.
 */
export const presignPortfolioMediaSchema = z
  .object({
    contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES),
    position: z.number().int().min(0).max(49),
  })
  .strict();

export const postIdParamsSchema = z.object({ postId: z.uuid() }).strict();

export const mediaParamsSchema = z.object({ postId: z.uuid(), mediaId: z.uuid() }).strict();

export const listPortfolioPostsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export type CreatePortfolioPostRequest = z.infer<typeof createPortfolioPostSchema>;
export type UpdatePortfolioPostRequest = z.infer<typeof updatePortfolioPostSchema>;
export type PresignPortfolioMediaRequest = z.infer<typeof presignPortfolioMediaSchema>;
export type ListPortfolioPostsQuery = z.infer<typeof listPortfolioPostsQuerySchema>;
