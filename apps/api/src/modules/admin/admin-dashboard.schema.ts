import { z } from 'zod';

export const MAX_DASHBOARD_RANGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `GET /admin/dashboard` (issue #246). Both ends optional: the default is the
 * last seven days. A range over ninety days is refused — this is a supply-gap
 * view, not a reporting tool (`admin-flow.md` § 6), and an unbounded range is
 * an unbounded scan.
 */
export const adminDashboardQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .transform((value, ctx) => {
    const to = value.to === undefined ? new Date() : new Date(value.to);
    const from =
      value.from === undefined ? new Date(to.getTime() - 7 * DAY_MS) : new Date(value.from);
    if (from.getTime() >= to.getTime()) {
      ctx.addIssue({ code: 'custom', message: '`from` must be before `to`.', path: ['from'] });
      return z.NEVER;
    }
    if (to.getTime() - from.getTime() > MAX_DASHBOARD_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: 'custom',
        message: `The range may be at most ${String(MAX_DASHBOARD_RANGE_DAYS)} days.`,
        path: ['from'],
      });
      return z.NEVER;
    }
    return { from, to };
  });

export type AdminDashboardQuery = z.output<typeof adminDashboardQuerySchema>;
