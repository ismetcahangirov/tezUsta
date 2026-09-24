import { z } from 'zod';

import { ORDER_STATUSES_EXCEPT_DRAFT, transitionReasonSchema } from '../orders/orders.schema';

/**
 * Validation for the admin override of an order's status (issue #137).
 *
 * **Its own file, importing the order module's vocabulary rather than
 * restating it.** `ORDER_STATUSES_EXCEPT_DRAFT` and the reason's bounds are
 * facts about orders, and a second copy here would be a second thing to update
 * when ADR-0015 next gains a status — with the copy that gets forgotten
 * failing as a 422 on a status the rest of the system considers ordinary.
 */

/**
 * `:orderId` rather than `:id`, matching `AdminOrderPhotosController` — the
 * admin surface names what it is addressing, because an admin route is read by
 * whoever is looking at a log line during an incident.
 */
export const adminOrderIdParamsSchema = z.object({ orderId: z.string().uuid() }).strict();

/**
 * **Every status but `DRAFT` is an acceptable *target*; the transition table
 * decides which of them is an acceptable *edge*.**
 *
 * That split is the whole design of this endpoint. Narrowing the enum to the
 * edges an admin is expected to need would be a second, smaller edge table
 * living in a validation schema — and the first time it disagreed with
 * `order-lifecycle.ts` the answer would depend on which check ran first. So
 * the boundary checks vocabulary and `assertOrderTransition` checks grammar,
 * with `{ kind: 'admin' }` bypassing the actor requirement and nothing else
 * (`backend-architecture.md` § Admin override).
 *
 * `DRAFT` is absent because no edge in the table leads to it: it is the
 * idempotency anchor of an in-flight creation, and an admin who could set an
 * order back to it would be able to hide one.
 */
export const adminTransitionOrderSchema = z
  .object({
    to: z.enum(ORDER_STATUSES_EXCEPT_DRAFT),
    /**
     * **Mandatory, with no exception and no default** (ADR-0015, and
     * `admin-flow.md`'s first non-negotiable: actor, action, target, reason,
     * timestamp). An override is somebody stepping outside the flow the
     * product describes, and the only thing that will ever explain why is the
     * sentence they typed — `order_status_history` is append-only, so there is
     * no second chance to add it.
     *
     * Not `.optional()` anywhere, which is the difference from the
     * customer-and-master schema: there a reason is required on two targets,
     * here on all of them.
     */
    reason: transitionReasonSchema,
  })
  .strict();

export type AdminTransitionOrderRequest = z.infer<typeof adminTransitionOrderSchema>;

/** The most orders one admin page returns, and the default. */
export const MAX_ADMIN_ORDERS_PAGE_SIZE = 100;
export const DEFAULT_ADMIN_ORDERS_PAGE_SIZE = 50;

const pageFields = {
  cursor: z.string().max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ADMIN_ORDERS_PAGE_SIZE)
    .default(DEFAULT_ADMIN_ORDERS_PAGE_SIZE),
};

/**
 * `GET /admin/orders` (issue #245). `status` takes a comma-separated list;
 * `stuck=true` keeps only accepted, on-the-way and arrived orders that have
 * not changed for two hours — "a master who accepted and vanished"
 * (`admin-flow.md` § 3).
 */
export const listAdminOrdersQuerySchema = z
  .object({
    status: z
      .string()
      .max(400)
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(z.array(z.enum(ORDER_STATUSES_EXCEPT_DRAFT)).min(1))
      .optional(),
    serviceId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    stuck: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
    ...pageFields,
  })
  .strict();

/** `GET /admin/orders/disputes` — the queue takes paging only. */
export const listDisputesQuerySchema = z.object(pageFields).strict();

export const adminOrderPartyParamsSchema = z
  .object({ orderId: z.uuid(), party: z.enum(['customer', 'master']) })
  .strict();

/** A phone number is revealed only with a reason (ADR-0043 § 6). */
export const revealPhoneSchema = z.object({ reason: z.string().trim().min(1).max(600) }).strict();
