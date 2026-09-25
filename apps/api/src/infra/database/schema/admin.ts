import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
 * The four admin roles ([ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 1).
 *
 * An enum, unlike `admin_audit_log.action`: the role set is a closed product
 * decision, and a fifth role is an ADR, not a string somebody types. What each
 * role may *do* is not here — the role → permission bundles live in code
 * (`admin-permissions.ts`), because they are read on every admin request and
 * change with the code that enforces them.
 */
export const adminRole = pgEnum('admin_role', ['support', 'moderator', 'finance', 'super_admin']);

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
 * **Credentials arrived with EPIC 13** (ADR-0043 § 2), on this row rather than
 * a side table: an admin has exactly one password and at most one enrolled
 * authenticator, and a join on every sign-in buys nothing. Roles are the
 * exception — an admin holds several — and live in `admin_user_roles`, so the
 * schema still assumes no single `is_admin` boolean (`admin-flow.md`).
 *
 * A row with no `password_hash` is an invited account that has not finished
 * setup. It cannot sign in, and neither can one whose TOTP is not enrolled:
 * there is no "enrol later" (ADR-0043 § 3).
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

    /**
     * `scrypt$N$r$p$salt$hash`, self-describing so the cost can be raised and
     * old hashes still verify (ADR-0043 § 2). Null until setup completes.
     */
    passwordHash: text('password_hash'),

    /**
     * The TOTP secret, AES-256-GCM encrypted under `ADMIN_TOTP_ENCRYPTION_KEY`
     * — never the base32 secret itself. A database dump alone must not be
     * enough to mint codes.
     */
    totpSecretEncrypted: text('totp_secret_encrypted'),

    /** When the authenticator was proven with a valid code. */
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),

    /**
     * The last 30-second step a code was accepted for. A step at or below it
     * is refused, so a code read over a shoulder is dead once used.
     */
    lastTotpStep: bigint('last_totp_step', { mode: 'number' }),

    /** The last password or second-factor change. */
    credentialsChangedAt: timestamp('credentials_changed_at', { withTimezone: true }),

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
    /**
     * An enrolment without a secret cannot verify a code, and a secret with no
     * enrolment is a half-finished setup that must not be mistaken for one.
     * The two are written together or not at all.
     */
    check(
      'admin_users_totp_enrolment',
      sql`(${table.totpSecretEncrypted} is null) = (${table.totpEnrolledAt} is null)`,
    ),
    check(
      'admin_users_last_totp_step_needs_enrolment',
      sql`${table.lastTotpStep} is null or ${table.totpEnrolledAt} is not null`,
    ),
  ],
);

/**
 * Which roles an admin holds — many-to-many (ADR-0043 § 1).
 *
 * The composite primary key is the uniqueness rule: holding a role twice means
 * nothing, so it cannot be written. Revoking a role deletes its row; who
 * granted and removed what is recorded in `admin_audit_log` with before/after,
 * which is where an investigator looks, rather than in soft-deleted rows every
 * permission lookup would have to skip.
 */
export const adminUserRoles = pgTable(
  'admin_user_roles',
  {
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    role: adminRole('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null only for the bootstrap command, which has no admin to act as. */
    grantedByAdminId: uuid('granted_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.adminUserId, table.role], name: 'admin_user_roles_pk' }),
    /** "Who holds this role" — the last-super-admin guard. */
    index('admin_user_roles_role_idx').on(table.role),
    index('admin_user_roles_granted_by_idx')
      .on(table.grantedByAdminId)
      .where(sql`${table.grantedByAdminId} is not null`),
  ],
);

/**
 * A single-use setup link (ADR-0043 § 3).
 *
 * Only the SHA-256 of the token is stored: the link is a credential, and a
 * database read must not yield a working one. It expires after 24 hours and is
 * spent by `used_at`; a newer invitation for the same admin revokes the older
 * ones rather than leaving two live links in circulation.
 */
export const adminInvitations = pgTable(
  'admin_invitations',
  {
    id: uuid('id').primaryKey(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    /** Null only for the bootstrap command. */
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('admin_invitations_token_hash_unique').on(table.tokenHash),
    index('admin_invitations_admin_live_idx')
      .on(table.adminUserId)
      .where(sql`${table.usedAt} is null and ${table.revokedAt} is null`),
    index('admin_invitations_created_by_idx')
      .on(table.createdByAdminId)
      .where(sql`${table.createdByAdminId} is not null`),
    check('admin_invitations_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'admin_invitations_spent_once',
      sql`${table.usedAt} is null or ${table.revokedAt} is null`,
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
    /**
     * "This admin's live sessions". Nothing orders by `expires_at` today — it
     * is carried so a future revoke-all screen can read the expiry without
     * touching the heap — but it is written as `sql` rather than `.desc()` so
     * that the first query to order by it gets the index instead of a sort
     * (#191).
     */
    index('admin_sessions_admin_live_idx')
      .on(table.adminUserId, sql`${table.expiresAt} desc`)
      .where(sql`${table.revokedAt} is null`),

    /**
     * The retention sweep (#276): `AdminRepository.deleteRetiredSessions` and
     * `deleteExpiredRefreshTokens` both select `expires_at <= cutoff or
     * revoked_at <= cutoff`, and with neither column indexed that was a read
     * of the whole table on every run (issue #289). The two indexes together
     * let Postgres answer the `or` as a bitmap union; the consumer
     * `sessions` table carries the same pair for the same sweep.
     */
    index('admin_sessions_expires_at_idx').on(table.expiresAt),
    index('admin_sessions_revoked_at_idx')
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} is not null`),
  ],
);

/**
 * One refresh token in an admin session's rotation chain (ADR-0043 § 4).
 *
 * Mirrors the consumer path's reuse rule without sharing its table: a token
 * presented after it was rotated means two parties hold the chain, and the
 * whole session is revoked. Only the SHA-256 is stored.
 */
export const adminRefreshTokens = pgTable(
  'admin_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => adminSessions.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('admin_refresh_tokens_token_hash_unique').on(table.tokenHash),
    index('admin_refresh_tokens_session_idx').on(table.sessionId),
    check('admin_refresh_tokens_token_hash_shape', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
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

    /**
     * The fields the action changed, before and after (`admin-flow.md`
     * non-negotiable 1, ADR-0043 § 6). Null for a read. Only the touched
     * fields — never a whole row, which would copy personal data into a table
     * that can never be redacted.
     */
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * "Everything done to this master", newest first — the detail view.
     *
     * `id` is the fourth column because `listAuditForTarget` breaks ties on it
     * (`created_at` defaults to `now()`, which is transaction time, so an admin
     * action that writes several rows at once gives them all the same stamp).
     * Without it Postgres serves the leading order from the index and then
     * adds an `Incremental Sort` for the tiebreaker (#191).
     */
    index('admin_audit_log_target_idx').on(
      table.targetType,
      table.targetId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),

    /**
     * The whole trail, newest first — the unfiltered audit log page
     * (issue #243). The two indexes above serve the actor and target filters;
     * without this one the first page of the log is a sort of the table.
     */
    index('admin_audit_log_created_idx').on(sql`${table.createdAt} desc`, sql`${table.id} desc`),

    /** "Everything this admin did", newest first — the investigation view. */
    index('admin_audit_log_actor_idx').on(
      table.adminUserId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),

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
export type AdminRoleName = (typeof adminRole.enumValues)[number];
export type AdminUserRoleRow = typeof adminUserRoles.$inferSelect;
export type AdminInvitationRow = typeof adminInvitations.$inferSelect;
export type AdminRefreshTokenRow = typeof adminRefreshTokens.$inferSelect;
export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLogRow = typeof adminAuditLog.$inferInsert;
