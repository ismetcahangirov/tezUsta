import type { NotificationCategory } from '@tezusta/types';
import { relations } from 'drizzle-orm';
import { boolean, pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * The switches a user is offered, as a closed set in the column itself.
 *
 * A `text` column would let a client store a preference for a category nothing
 * ever reads — and the user would then be certain they had switched something
 * off. The Zod schema at the boundary is the control; this is the backstop,
 * and the two are held in step by the assertions at the foot of this file.
 */
export const notificationCategory = pgEnum('notification_category', [
  'order-offers',
  'order-accepted',
  'order-progress',
  'order-cancelled',
  'order-no-master-found',
  'messages',
]);

/**
 * One row per preference a user has actually expressed.
 *
 * **The absence of a row is the default, and that is the design rather than an
 * optimisation.** A fully-populated table would mean every new category ships
 * with a migration writing a row for every user — and a user created between
 * that migration and the deploy would still have no row, so the send path
 * would have to interpret a missing row anyway. Interpreting it is the
 * storage: a category nobody has touched costs nothing and behaves exactly as
 * `notification-categories.ts` says it should.
 *
 * **Keyed by user, never by device.** Silencing a category on one phone and
 * not the other is a setting nobody asked for and a support question waiting
 * to happen ("I turned it off and I still get them"). One switch, every
 * device — which also means a new phone inherits the choice without
 * re-registering it.
 *
 * There is no `id`: `(user_id, category)` **is** the identity. A surrogate key
 * would need a unique index on exactly that pair anyway, and would let two
 * rows disagree about one user's answer for one category in the window before
 * somebody noticed the index was missing.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    /**
     * `restrict` rather than `cascade`, per
     * `docs/architecture/database-architecture.md` § Integrity rules. A
     * preference is not history worth protecting, but a delete that quietly
     * takes rows with it is the behaviour that rule exists to keep out of the
     * schema — a user is soft-deleted, so this never fires in practice.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    category: notificationCategory('category').notNull(),

    /**
     * Named positively, per the conventions table. Not nullable and without a
     * default: a row exists **because** the user said something, so a row that
     * did not say which way would be indistinguishable from no row while
     * costing a lookup.
     */
    isEnabled: boolean('is_enabled').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * **The composite primary key is also the only index this table needs**,
     * and both reads are on it. The worker asks "what has this user stored?",
     * which is a range scan on the leading column; the settings endpoints ask
     * the same question. The foreign key on `user_id` is covered by the same
     * leading column, so the "every foreign key gets an index" rule is
     * satisfied without a second one (CLAUDE.md §12).
     *
     * The read sits on the send path, one small lookup per job — the cost the
     * decision to filter at send rather than at enqueue buys the correctness
     * with.
     */
    primaryKey({ columns: [table.userId, table.category] }),
  ],
);

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [notificationPreferences.userId],
    references: [users.id],
  }),
}));

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferenceRow = typeof notificationPreferences.$inferInsert;

/**
 * The column type and the wire contract describe the same set, in both
 * directions — the guarantee `orders.ts` makes for `order_status`, for the
 * same reason. Adding a category to `packages/types` and forgetting the enum
 * typechecks everywhere and then fails at runtime against a value Postgres
 * rejects, at the moment a user tries to save a setting.
 */
type AssertNever<T extends never> = T;

/** No category exists in the column that the API contract cannot name. */
export type NotificationCategoryEnumHasNoStrangers = AssertNever<
  Exclude<(typeof notificationCategory.enumValues)[number], NotificationCategory>
>;
/** And none exists in the contract that the column cannot store. */
export type NotificationCategoryEnumIsComplete = AssertNever<
  Exclude<NotificationCategory, (typeof notificationCategory.enumValues)[number]>
>;
