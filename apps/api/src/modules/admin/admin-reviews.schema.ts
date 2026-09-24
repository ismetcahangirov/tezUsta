import { z } from 'zod';

/**
 * `POST /admin/ratings/recalculate` (#223): one master, one customer, or —
 * with an empty body — everybody. Naming both is refused rather than
 * interpreted: "recalculate these two unrelated profiles" is two requests.
 */
export const recalculateRatingsSchema = z
  .object({
    masterId: z.uuid().optional(),
    customerId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => value.masterId === undefined || value.customerId === undefined, {
    message: 'Name a master, a customer, or neither — not both.',
    path: ['customerId'],
  });

/** The most reviews one admin page returns, and the default. */
export const MAX_ADMIN_REVIEWS_PAGE_SIZE = 100;
export const DEFAULT_ADMIN_REVIEWS_PAGE_SIZE = 50;

/** `GET /admin/reviews` (#224). Every filter is optional and they combine with AND. */
export const listAdminReviewsQuerySchema = z
  .object({
    orderId: z.uuid().optional(),
    masterId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_ADMIN_REVIEWS_PAGE_SIZE)
      .default(DEFAULT_ADMIN_REVIEWS_PAGE_SIZE),
  })
  .strict();

export const adminReviewIdParamsSchema = z.object({ reviewId: z.uuid() }).strict();

/**
 * `POST /admin/reviews/:reviewId/removal` (#224). The reason is mandatory and
 * bounded exactly as `reviews_removal_reason_length` and
 * `admin_audit_log_reason_length` bound it — both columns receive it.
 */
export const removeReviewSchema = z.object({ reason: z.string().trim().min(1).max(600) }).strict();

export type RecalculateRatingsBody = z.infer<typeof recalculateRatingsSchema>;
export type ListAdminReviewsQuery = z.infer<typeof listAdminReviewsQuerySchema>;
export type RemoveReviewBody = z.infer<typeof removeReviewSchema>;
