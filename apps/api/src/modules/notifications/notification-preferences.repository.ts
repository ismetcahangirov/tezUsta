import { Inject, Injectable } from '@nestjs/common';
import { and, eq, notInArray, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { notificationPreferences } from '../../infra/database/schema/notification-preferences';
import type { NotificationCategory, StoredPreferences } from './notification-categories';

/** One stored preference, as a caller asks for it to be written. */
export interface StoredPreference {
  readonly category: NotificationCategory;
  readonly isEnabled: boolean;
}

@Injectable()
export class NotificationPreferencesRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * What this user has actually stored, as a map keyed by category.
   *
   * **A map rather than rows, because absence is the answer to most of the
   * questions asked of it.** The caller resolves each category against
   * `notification-categories.ts`, and a `Map` makes "nothing stored" a miss
   * rather than a scan.
   *
   * Reads the composite primary key on its leading column — the only index
   * this table has, and the only one it needs. This runs once per notification
   * job, on the send path.
   */
  async findByUser(userId: string): Promise<StoredPreferences> {
    const rows = await this.db
      .select({
        category: notificationPreferences.category,
        isEnabled: notificationPreferences.isEnabled,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    return new Map(rows.map((row) => [row.category, row.isEnabled]));
  }

  /**
   * Make this user's stored preferences exactly `entries`.
   *
   * **A replace rather than an upsert, in one transaction.** The body of a
   * `PUT` is the complete set, so a category it no longer names must lose its
   * row and go back to its default — an upsert alone would leave the table
   * growing and a preference the user believed they had cleared still in
   * force. Doing both halves in one transaction is what stops a concurrent
   * read from seeing the delete without the insert, which would look to the
   * worker like the user had briefly reset everything.
   *
   * Idempotent: the same call twice leaves the same rows, because the delete
   * is scoped by what survives and the insert resolves its conflict on the
   * primary key.
   */
  async replaceForUser(userId: string, entries: readonly StoredPreference[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const surviving = entries.map((entry) => entry.category);

      // `notInArray` with an empty list is not valid SQL, and the empty case
      // is a real request — it is what "put everything back to default" looks
      // like — so the two are separate statements rather than one clever one.
      await tx
        .delete(notificationPreferences)
        .where(
          surviving.length === 0
            ? eq(notificationPreferences.userId, userId)
            : and(
                eq(notificationPreferences.userId, userId),
                notInArray(notificationPreferences.category, surviving),
              ),
        );

      if (entries.length === 0) {
        return;
      }

      await tx
        .insert(notificationPreferences)
        .values(
          entries.map((entry) => ({
            userId,
            category: entry.category,
            isEnabled: entry.isEnabled,
          })),
        )
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.category],
          set: {
            /**
             * `excluded.is_enabled` — the value *this* statement tried to
             * insert, rather than a literal.
             *
             * A multi-row `INSERT ... ON CONFLICT DO UPDATE` has one `set`
             * clause for every row it touches, so a literal here would write
             * the same value to all of them. Postgres's `excluded`
             * pseudo-table is what makes each conflicting row take its own
             * incoming value. The column name comes from the schema rather
             * than from a string, so a rename moves both together.
             */
            isEnabled: sql`excluded.${sql.raw(notificationPreferences.isEnabled.name)}`,
            updatedAt: new Date(),
          },
        });
    });
  }
}
