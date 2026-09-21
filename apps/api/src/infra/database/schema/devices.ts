import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * Which app store's push transport is behind this token.
 *
 * Recorded rather than inferred, because the token itself does not say — an
 * `ExponentPushToken[...]` looks identical on both platforms, and a delivery
 * problem that turns out to be one platform's credentials is the first
 * question anybody asks. `web` is deliberately absent: `apps/mobile` is the
 * only client, and a value nothing can produce is a value some later query
 * will have to handle for no reason.
 */
export const devicePlatform = pgEnum('device_platform', ['ios', 'android']);

/**
 * Why a device stopped receiving notifications.
 *
 * It exists for the reason `sessions.revoked_reason` does: "why did my old
 * phone stop getting notifications?" is a support question, and a recorded
 * answer beats a reconstructed one.
 *
 * - `unregistered` — the client said so, at sign-out (#140).
 * - `unreachable` — the push provider said so. Expo answers `DeviceNotRegistered`
 *   for an install that is gone, and both Apple and Google penalise senders
 *   who keep pushing to one (#141).
 *
 * `unreachable` arrived with #141 rather than with #142 as #140 predicted,
 * because the code can appear in a **ticket** as well as in a receipt —
 * `expo-server-sdk@7.2.0` declares `ExpoPushErrorTicket = ExpoPushErrorReceipt`,
 * so the send path meets it first.
 */
export const deviceRevokedReason = pgEnum('device_revoked_reason', ['unregistered', 'unreachable']);

/**
 * One row per push-addressable installation of the app.
 *
 * **Separate from `sessions`, and the reason is lifetime rather than tidiness.**
 * A session is the refresh-token family: it is revoked at sign-out, at
 * `logout_all`, on `reuse_detected` and on suspension, and a new one is minted
 * at the next sign-in (`docs/architecture/authentication.md` § Sessions and
 * devices). A push token belongs to the OS installation and survives every one
 * of those. Hanging the token off the session would discard the registration
 * each time the user signed out, and would turn "notify this user on all their
 * devices" into a query over revoked families.
 *
 * **Separate from `users`** for the reason `docs/architecture/database-architecture.md`
 * § Decisions already settled states: one user has several phones, and a token
 * column on `users` breaks the moment they own two.
 *
 * The row is **user-scoped, not role-scoped**. One binary carries both customer
 * and master (CLAUDE.md §2), so a device receives whatever the event concerns
 * and the role never enters this table.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    platform: devicePlatform('platform').notNull(),

    /**
     * The address Expo delivers to. **Not a credential, and still not
     * loggable** — anyone holding it can push to that phone, so CLAUDE.md §11's
     * rule against logging tokens covers it, and the API only ever returns a
     * short suffix.
     *
     * Length-capped rather than `text`, per `docs/engineering/security.md`:
     * an unbounded column one client can write is a storage problem. Expo's
     * own tokens are around forty characters; the cap is a backstop, and the
     * Zod schema at the boundary is the control.
     */
    expoPushToken: varchar('expo_push_token', { length: 255 }).notNull(),

    /**
     * Client-supplied and **never trusted for authorization**, exactly like
     * `sessions.device_id` — it exists so a device list reads "Pixel 7" rather
     * than an opaque uuid.
     */
    deviceId: varchar('device_id', { length: 128 }),
    appVersion: varchar('app_version', { length: 32 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /**
     * Moved every time the client re-registers, which is the only evidence the
     * server ever gets that an install is still alive. A retention sweep for
     * installations nobody has opened in months filters on this; writing that
     * sweep is not this issue's work, but the column it needs is.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: deviceRevokedReason('revoked_reason'),
  },
  (table) => [
    /**
     * **Unique across the whole table, and deliberately not partial.**
     *
     * Two properties depend on it. The first is that registration can be one
     * `INSERT ... ON CONFLICT (expo_push_token) DO UPDATE` — a read-then-write
     * would let two API replicas register one token twice, and the
     * reassignment below is precisely the case that races.
     *
     * The second is why the predicate is absent. A partial index
     * `WHERE revoked_at IS NULL` would let a retired row keep its token while
     * a fresh registration inserted a second row for the same phone, so the
     * same install would hold two rows and receive everything twice. Matching
     * the retired row instead is what makes signing back in reachable again
     * rather than duplicated.
     */
    uniqueIndex('devices_expo_push_token_unique').on(table.expoPushToken),

    /**
     * The push fan-out index `docs/architecture/database-architecture.md`
     * § Indexing names: "every live device of this user" is the only read the
     * notification worker ever performs, and it is on the send path.
     */
    index('devices_user_id_live_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),

    /**
     * A retired device names why, and a live one names nothing.
     *
     * The direction that bites is re-registration that clears `revoked_at` and
     * forgets `revoked_reason`, leaving a live row carrying the reason it was
     * once retired — the same failure `masters.suspended_at` is guarded against
     * (`docs/architecture/database-architecture.md`).
     */
    check(
      'devices_revocation_shape',
      sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`,
    ),
  ],
);

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, {
    fields: [devices.userId],
    references: [users.id],
  }),
}));

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
