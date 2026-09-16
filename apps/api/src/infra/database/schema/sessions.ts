import { relations } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * Why a session was revoked. Every entry corresponds to a row of the table in
 * `docs/architecture/authentication.md` § Sessions and devices, and the column
 * exists so a support conversation ("why was I signed out?") has an answer
 * that is recorded rather than reconstructed.
 *
 * `reuse_detected` is the one that matters operationally: it is the visible
 * trace of the refresh-token theft signal, and it is what makes the detection
 * an auditable event rather than a silent logout.
 */
export const sessionRevokedReason = pgEnum('session_revoked_reason', [
  'logout',
  'logout_all',
  'reuse_detected',
  'suspension',
  'phone_change',
]);

/**
 * One row per device session — "sign out on that other phone" is only
 * implementable because this row exists separately from the user
 * (`docs/architecture/authentication.md` § At rest).
 *
 * A session is the refresh **family**: every refresh token ever issued for
 * this device points here, and revoking the session invalidates all of them at
 * once. The session itself holds no token value — see `refreshTokens` below
 * for why the hash lives one table further down.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * Client-supplied, and therefore **never** trusted for authorization — it
     * exists so the device list a user sees says "Pixel 7" rather than an
     * opaque uuid. Nullable because a client may legitimately not send one.
     *
     * Length-capped rather than `text`. `docs/engineering/security.md`: "an
     * unbounded text field is a denial-of-service vector and a storage
     * problem", and one client opening sessions with a megabyte user agent
     * each is exactly that. The cap is a backstop, not the control — the Zod
     * schema at the sign-in boundary (issue #29) is what turns an over-long
     * value into a 422 rather than a database error.
     */
    deviceId: varchar('device_id', { length: 128 }),
    userAgent: varchar('user_agent', { length: 512 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Maintained on every UPDATE — see the note on `users.updated_at`. */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * The absolute end of the family, set from `JWT_REFRESH_TTL` at sign-in and
     * **not extended by rotation**. Without this a session that refreshes every
     * fifteen minutes would live forever, and "30-day refresh token" would
     * describe nothing.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: sessionRevokedReason('revoked_reason'),
  },
  (table) => [
    // "List my devices", and the logout-everywhere / suspension sweeps, all
    // filter by user.
    index('sessions_user_id_idx').on(table.userId),
    // Same reasoning as `refresh_tokens_expires_at_idx`: the maintenance sweep
    // that retires expired families would otherwise scan the table.
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * One row per refresh token ever **issued**, not one row per session.
 *
 * This is what makes reuse detection possible at all. If the current hash were
 * kept on `sessions` and overwritten on every rotation, a replayed spent token
 * would hash to a value matching nothing — indistinguishable from a corrupt
 * string — and the server could not tell theft from noise. Keeping the spent
 * rows means a replay lands on a row that exists and already has `used_at`
 * set, which is precisely the theft signal
 * (`docs/architecture/authentication.md` § Refresh rotation with reuse
 * detection).
 *
 * It also makes consumption atomic without a transaction or a lock: redeeming
 * a token is `UPDATE ... SET used_at = now() WHERE id = $1 AND used_at IS NULL
 * RETURNING *`, and the loser of a race gets zero rows — the same conditional-
 * update pattern the order accept uses
 * (`docs/architecture/backend-architecture.md` § Concurrent accept).
 *
 * Rows are append-only and carry no `updated_at`: `used_at` is written exactly
 * once, by that conditional update, and nothing else about a row ever changes.
 * Pruning expired rows is maintenance work for the `maintenance` queue, not
 * something a request path does.
 *
 * **The hash choice is load-bearing for that atomicity, not merely a storage
 * decision.** Because `token_hash` is a deterministic keyed digest, the
 * presented secret can be hashed once and compared inside the same `WHERE`
 * clause as `used_at IS NULL`, so verification and consumption are one
 * statement. Replacing it with a salted, per-row KDF (bcrypt, argon2) would
 * force a read-then-compare-then-write, reopening exactly the window this
 * design closes. Do not "harden" it into a slow hash without replacing the
 * atomicity with something else that works.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    /**
     * Also the public half of the token string presented by the client
     * (`<id>.<secret>`), which is what lets verification be a single indexed
     * lookup instead of a scan that hashes every candidate row.
     */
    id: uuid('id').primaryKey(),

    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),

    /**
     * HMAC-SHA256 of the token's secret half, keyed by `JWT_REFRESH_SECRET`.
     * **Never the token itself.** A database read — a leaked backup, an
     * injection, an over-privileged admin — must not yield a usable credential
     * (`docs/architecture/authentication.md` § At rest). Keying the digest with
     * a server-held secret, rather than taking a bare SHA-256, means a stolen
     * dump cannot be attacked offline at all without also stealing the
     * application secret.
     */
    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Null until redeemed. Set once, by the conditional update above. */
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    // Revoking or auditing a family walks its tokens by session.
    index('refresh_tokens_session_id_idx').on(table.sessionId),
    // The maintenance sweep that deletes expired rows; without it that job is
    // a full scan of the largest table in the auth schema.
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  refreshTokens: many(refreshTokens),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  session: one(sessions, { fields: [refreshTokens.sessionId], references: [sessions.id] }),
}));

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type NewRefreshTokenRow = typeof refreshTokens.$inferInsert;
export type SessionRevokedReasonName = (typeof sessionRevokedReason.enumValues)[number];
