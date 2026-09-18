import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Whether an admin account may be used at all.
 *
 * Separate from `user_status` even though the values rhyme. The two account
 * stores never share a type, because sharing one is the first step towards
 * sharing a query, and the whole point of
 * [ADR-0014](docs/decisions/ADR-0014-admin-authentication.md) is that a
 * consumer account and an admin account have nothing in common.
 */
export const adminUserStatus = pgEnum('admin_user_status', ['active', 'disabled']);

/**
 * An administrator. **Not a role on `users`.**
 *
 * ADR-0014 is structural about this: an admin is a row in a different table,
 * with a different credential path, and nothing links it to any consumer
 * account. A person who is both holds an `admin_users` row *and* a separate
 * `users` row. That is what makes "an admin session never grants customer or
 * master capability" a property of the schema rather than a rule somebody has
 * to remember.
 *
 * **There is no password or TOTP column here, and that is deliberate.**
 * ADR-0014 assigns admin *authorization* — the account store, the guard, the
 * checks — to EPIC 2, and admin *credential issuance* to EPIC 13. Adding a
 * `password_hash` now would mean choosing a hashing scheme for a flow nobody
 * has written, and CLAUDE.md §20 forbids creating entities for a future Epic.
 * The columns arrive with the sign-in path that fills them.
 *
 * **There is no permission model here either**, for the same reason and with
 * one extra: `docs/product/admin-flow.md` requires that the schema "must not
 * assume a single `is_admin` boolean", and it does not — an admin is an
 * account, not a flag, so granular permissions land in EPIC 13 as a table
 * beside this one rather than as a rewrite of it. Until then every admin can
 * take every admin action, and every one of them is in `admin_audit_log`.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey(),

    /**
     * Stored lower-cased, and unique that way.
     *
     * Email is case-insensitive in practice, so `Admin@tezusta.az` and
     * `admin@tezusta.az` must not be two accounts — that is two sets of
     * privileges for one person and only one of them gets disabled when
     * somebody leaves. The CHECK refuses anything with an upper-case
     * character rather than trusting every writer to normalise, since a seed
     * script or a future provisioning tool is exactly what would not.
     */
    email: text('email').notNull(),

    displayName: text('display_name').notNull(),

    status: adminUserStatus('status').notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * Partial on the live rows, unlike `masters_user_id_unique` and like
     * `users_phone_e164_live_unique`. An address genuinely can be reassigned —
     * a company mailbox outlives the person who read it — so a soft-deleted
     * account must not block provisioning the next holder.
     */
    uniqueIndex('admin_users_email_live_unique')
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),

    check('admin_users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check(
      'admin_users_email_shape',
      sql`length(${table.email}) between 3 and 320 and position('@' in ${table.email}) > 1`,
    ),
    check(
      'admin_users_display_name_length',
      sql`length(btrim(${table.displayName})) between 1 and 80`,
    ),
  ],
);

/**
 * An admin's active session.
 *
 * Deliberately **not** the consumer `sessions` table, and deliberately much
 * smaller than it. ADR-0014 gives the admin path its own session policy —
 * 8-hour families, a 30-minute idle timeout, no device list — and the two
 * token families share neither an issuer nor an audience. A shared table
 * would be a shared query away from a consumer refresh token opening an admin
 * session.
 *
 * **There is no refresh-token table beside this one.** Refresh exists to keep
 * a long-lived login alive across a short access token, and nothing issues an
 * admin login yet: EPIC 13 owns credential issuance. What issue #39 needs is
 * that admin endpoints are *guarded* and *revocable* against current database
 * state, and this table is what makes both true. Rotation arrives with the
 * sign-in flow that needs it.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey(),

    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Moved forward on every authenticated request, and what the **30-minute
     * idle timeout** is measured from (ADR-0014). An admin console left open
     * on an unattended laptop is a different risk from a phone in a pocket,
     * which is why the consumer path has no equivalent.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('admin_sessions_admin_live_idx')
      .on(table.adminUserId, table.expiresAt.desc())
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Every administrative action, append-only.
 *
 * `docs/product/admin-flow.md`, non-negotiable 1: actor, action, target,
 * reason, timestamp — **including reads of personal data**, because a read is
 * an action. An unlogged admin action is indistinguishable from an attacker's.
 *
 * Enforced by trigger, not by convention: `0009_admin_identity.sql` installs a
 * function that raises on UPDATE and DELETE, plus a second trigger for
 * TRUNCATE, which bypasses row-level triggers. An audit trail whose integrity
 * depends on every future query being careful is not an audit trail.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey(),

    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),

    /**
     * A dotted lower-case verb — `master.verify`, `master.document.read`.
     *
     * Text with a format CHECK rather than a Postgres enum, which is the
     * opposite of the choice every *domain* status in this schema makes, and
     * for a reason that does not apply to those. An enum is right for a closed
     * set the product decided; the set of administrative actions grows with
     * every admin feature, and a migration per new verb would push people
     * towards reusing an existing one — which is how an audit trail quietly
     * stops describing what happened.
     */
    action: text('action').notNull(),

    /** What kind of thing was acted on — `master`, `master_document`. */
    targetType: text('target_type').notNull(),

    /**
     * Which one. A plain `uuid` with **no** foreign key, on purpose: the log
     * has to outlive its target, and a reference that forbade deleting a row
     * would make the audit trail a reason not to keep records rather than a
     * record of them.
     */
    targetId: uuid('target_id').notNull(),

    /**
     * Why, where the action demands one.
     *
     * Which actions require a reason is policy about the action
     * ([ADR-0023](docs/decisions/ADR-0023-master-verification-policy.md)) and
     * is enforced in the service. A CHECK here would have to enumerate the
     * verbs, which is exactly what `action` being open text avoids.
     */
    reason: text('reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** "Everything done to this master", newest first — the detail view. */
    index('admin_audit_log_target_idx').on(
      table.targetType,
      table.targetId,
      table.createdAt.desc(),
    ),

    /** "Everything this admin did", newest first — the investigation view. */
    index('admin_audit_log_actor_idx').on(table.adminUserId, table.createdAt.desc()),

    check(
      'admin_audit_log_action_shape',
      // The separator is written as the character class `[.]` rather than as
      // an escaped `\.`, because a JavaScript template literal consumes the
      // backslash: the escaped form reaches Postgres as a bare `.`, which
      // matches ANY character, and `masterXverify` would pass a check that
      // looks like it enforces a dotted verb. A character class needs no
      // escape and cannot be silently unescaped by anything in between.
      sql`${table.action} ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$' and length(${table.action}) <= 64`,
    ),
    check(
      'admin_audit_log_target_type_shape',
      sql`${table.targetType} ~ '^[a-z][a-z0-9_]*$' and length(${table.targetType}) <= 32`,
    ),
    check(
      'admin_audit_log_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 600`,
    ),
  ],
);

export const adminSessionsRelations = relations(adminSessions, ({ one }) => ({
  adminUser: one(adminUsers, {
    fields: [adminSessions.adminUserId],
    references: [adminUsers.id],
  }),
}));

export const adminAuditLogRelations = relations(adminAuditLog, ({ one }) => ({
  adminUser: one(adminUsers, {
    fields: [adminAuditLog.adminUserId],
    references: [adminUsers.id],
  }),
}));

export type AdminUserRow = typeof adminUsers.$inferSelect;
export type NewAdminUserRow = typeof adminUsers.$inferInsert;
export type AdminUserStatusName = (typeof adminUserStatus.enumValues)[number];
export type AdminSessionRow = typeof adminSessions.$inferSelect;
export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLogRow = typeof adminAuditLog.$inferInsert;
