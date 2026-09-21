import { z } from 'zod';

import { NOTIFICATION_CATEGORIES } from './notification-categories';

/**
 * Validation for the notification-preference endpoints.
 *
 * Written as if it were already a package (ADR-0016): no Nest, Fastify or
 * Drizzle type appears below, so the day `apps/mobile` reuses these shapes
 * (#147) the move to `packages/validation` is a file move rather than a
 * rewrite.
 */

/**
 * Built from the category list rather than a literal copy of it, so a
 * category added to the union is accepted here without anybody remembering to
 * widen this — and one removed stops being accepted immediately.
 */
const category = z.enum(NOTIFICATION_CATEGORIES);

/**
 * `.strict()` so an unknown key is a 422 rather than a silently dropped
 * field, and here it closes a specific hole: a client sending `sound` or
 * `quietHours` alongside a toggle would get a 200 and no sound setting.
 * Quiet hours and per-category sounds are product decisions nobody has made
 * (CLAUDE.md §17), and refusing the field is how the API says so.
 */
const preference = z
  .object({
    category,
    enabled: z.boolean(),
  })
  .strict();

/**
 * The write body: **the complete set, not a patch.**
 *
 * A category the body does not name returns to its default. That is what
 * makes the write idempotent and what lets the stored rows stay sparse — and
 * the read returns every category anyway, so a client always has the whole
 * set to send back.
 *
 * `.strict()` at this level closes the other hole: a body carrying `userId`
 * would look like it was choosing an owner. It never is — the owner is the
 * authenticated actor — and refusing the request is the loudest way to say so.
 */
export const updateNotificationPreferencesSchema = z
  .object({
    preferences: z
      .array(preference)
      /**
       * One entry per category at most, so the body cannot contradict itself.
       * Without this, `[{progress, false}, {progress, true}]` would be
       * resolved by whichever entry the loop happened to write last — a
       * silent coin toss over a setting the user believes they chose.
       */
      .max(NOTIFICATION_CATEGORIES.length)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.category)).size === entries.length,
        { message: 'A category may appear at most once.' },
      ),
  })
  .strict();

export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesSchema
>;
