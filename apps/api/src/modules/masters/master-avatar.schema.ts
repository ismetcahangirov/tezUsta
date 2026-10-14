import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../infra/storage/image-content-type';

/** An avatar presign (#309): images only, the portfolio's allow-list. */
export const presignAvatarSchema = z
  .object({ contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES) })
  .strict();

export const avatarUploadParamsSchema = z.object({ uploadId: z.uuid() }).strict();

export type PresignAvatarRequest = z.infer<typeof presignAvatarSchema>;
