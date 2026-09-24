import { z } from 'zod';

const ADMIN_ROLES = ['support', 'moderator', 'finance', 'super_admin'] as const;

/** The same bounds `admin_users` and `admin_audit_log` enforce. */
const reason = z.string().trim().min(1).max(600);
const roles = z
  .array(z.enum(ADMIN_ROLES))
  .min(1, 'An admin needs at least one role.')
  .max(ADMIN_ROLES.length)
  .refine((value) => new Set(value).size === value.length, 'Each role once.');

export const adminAccountIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const adminAccountReasonSchema = z.object({ reason }).strict();

export const inviteAdminSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
    displayName: z.string().trim().min(1).max(80),
    roles,
  })
  .strict();

export const setAdminRolesSchema = z.object({ roles, reason }).strict();
