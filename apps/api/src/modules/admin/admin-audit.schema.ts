import { z } from 'zod';

export const MAX_AUDIT_PAGE_SIZE = 100;
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * `GET /admin/audit-log` (issue #243). Every filter is optional; they combine
 * with AND. `action` is a prefix on whole segments — `master` matches
 * `master.verify` and `master.document.read`, never `masters.x`.
 */
export const listAdminAuditLogQuerySchema = z
  .object({
    actorId: z.uuid().optional(),
    targetType: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(32)
      .optional(),
    targetId: z.uuid().optional(),
    action: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
      .max(64)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE_SIZE).default(DEFAULT_AUDIT_PAGE_SIZE),
  })
  .strict()
  .refine((value) => value.targetId === undefined || value.targetType !== undefined, {
    message: 'A target id needs its target type.',
    path: ['targetId'],
  })
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      Date.parse(value.from) < Date.parse(value.to),
    { message: '`from` must be before `to`.', path: ['to'] },
  );

export type ListAdminAuditLogQuery = z.infer<typeof listAdminAuditLogQuerySchema>;
