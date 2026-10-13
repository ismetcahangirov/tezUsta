import { z } from 'zod';

import { REPORT_REASON_CODES } from '../reports/reports.schema';
import { MAX_PAGE_SIZE } from './admin-masters.schema';

export const REPORT_OUTCOMES = [
  'no_action',
  'warning_recorded',
  'master_suspended',
  'customer_suspended',
] as const;

export const reportIdParamsSchema = z.object({ id: z.uuid() }).strict();

export const listReportsQuerySchema = z
  .object({
    status: z.enum(['open', 'in_review', 'closed']).optional(),
    reason: z.enum(REPORT_REASON_CODES).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .strict();

/** Claiming takes no body; a strict empty object refuses one rather than dropping it. */
export const claimReportSchema = z.object({}).strict();

/** Every outcome carries its reason (ADR-0053 § 4); the CHECK caps it at 600. */
export const closeReportSchema = z
  .object({
    outcome: z.enum(REPORT_OUTCOMES),
    reason: z.string().trim().min(1).max(600),
  })
  .strict();

export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
export type CloseReportInput = z.infer<typeof closeReportSchema>;
