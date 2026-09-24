import { z } from 'zod';

import { callStatus } from '../../infra/database/schema/calls';
import { callCursor, callPageLimit } from '../calls/calls.schema';

/**
 * `GET /admin/calls`. Every filter optional, all combined with `AND`.
 *
 * `from` is inclusive and `to` exclusive, both on `started_at` and both with
 * an explicit offset — an admin in Baku and a server in UTC must not disagree
 * about which day a call was on. `masterId` and `customerId` are profile ids,
 * the ids the rest of the admin surface uses; there is no filter by phone
 * number, for the reason no response carries one.
 */
export const listAdminCallsQuerySchema = z
  .object({
    orderId: z.uuid().optional(),
    // The column's own enum values, not a second list of them.
    status: z.enum(callStatus.enumValues).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    masterId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    cursor: callCursor,
    limit: callPageLimit,
  })
  .strict()
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      new Date(query.from).getTime() < new Date(query.to).getTime(),
    { message: '`from` must be before `to`', path: ['to'] },
  );

export type ListAdminCallsQuery = z.infer<typeof listAdminCallsQuerySchema>;
