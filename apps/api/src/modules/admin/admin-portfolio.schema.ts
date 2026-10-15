import { z } from 'zod';

/** Portfolio moderation (#312). Pre-`packages/validation` code (ADR-0016). */

export const MAX_ADMIN_PORTFOLIO_PAGE_SIZE = 100;
export const DEFAULT_ADMIN_PORTFOLIO_PAGE_SIZE = 50;

export const listAdminPortfolioQuerySchema = z
  .object({
    masterId: z.uuid().optional(),
    status: z.enum(['draft', 'processing', 'published', 'failed', 'deleted', 'removed']).optional(),
    /** ISO 8601; `createdAt` at or after. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** ISO 8601; `createdAt` at or before. */
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_ADMIN_PORTFOLIO_PAGE_SIZE)
      .default(DEFAULT_ADMIN_PORTFOLIO_PAGE_SIZE),
  })
  .strict()
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      Date.parse(value.from) <= Date.parse(value.to),
    { message: '`from` must not be after `to`.', path: ['from'] },
  );

export const adminPortfolioPostParamsSchema = z.object({ postId: z.uuid() }).strict();

export const adminMasterAvatarParamsSchema = z.object({ masterId: z.uuid() }).strict();

/** A removal's reason: mandatory, 1–600 characters, as a review's (ADR-0042 § 7). */
export const removalReasonSchema = z.object({ reason: z.string().trim().min(1).max(600) }).strict();

export type ListAdminPortfolioQuery = z.infer<typeof listAdminPortfolioQuerySchema>;
export type RemovalReasonBody = z.infer<typeof removalReasonSchema>;
