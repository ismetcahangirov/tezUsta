import { z } from 'zod';

import { MAX_PAGE_SIZE } from './admin-masters.schema';

/**
 * Why an admin read an address, suspended an account or lifted a suspension.
 * Bounded as every admin reason is: the audit log's CHECK caps it at 600.
 */
const reason = z.string().trim().min(1).max(600);

const cursor = z.string().min(1).max(200);

export const customerIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listCustomersQuerySchema = z
  .object({
    /**
     * A name prefix, a customer id, or a **whole** email address. A part of
     * an address is read as a name and so finds nobody — a partial match
     * would let an admin walk the address book (#328). 254 is the longest
     * address sign-in accepts.
     */
    q: z.string().trim().min(1).max(254).optional(),
    status: z.enum(['active', 'suspended', 'deleted']).optional(),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .strict();

export const listCustomerOrdersQuerySchema = z
  .object({
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .strict();

/** `email`, `suspend` and `reinstate` all require one. */
export const customerReasonSchema = z.object({ reason }).strict();

export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
export type ListCustomerOrdersQuery = z.infer<typeof listCustomerOrdersQuerySchema>;
