import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { AdminAccount } from '@tezusta/types';

import type {
  AdminInvitationRow,
  AdminRefreshTokenRow,
  AdminRoleName,
  AdminSessionRow,
  AdminUserRow,
  AdminUserStatusName,
} from '../../infra/database/schema/admin';
import {
  adminAuditLog,
  adminInvitations,
  adminRefreshTokens,
  adminSessions,
  adminUserRoles,
  adminUsers,
} from '../../infra/database/schema/admin';

/** One row of the administrative audit trail, as a caller supplies it. */
export interface AuditEntry {
  readonly adminUserId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason?: string | undefined;
  /**
   * The fields the action changed, before and after (ADR-0043 § 6). Only the
   * touched fields — never a whole row, which would copy personal data into a
   * table that can never be redacted.
   */
  readonly before?: Record<string, unknown> | undefined;
  readonly after?: Record<string, unknown> | undefined;
}

@Injectable()
export class AdminRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findLiveAdminById(
    id: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminUserRow | undefined> {
    const [row] = await executor
      .select()
      .from(adminUsers)
      .where(and(eq(adminUsers.id, id), isNull(adminUsers.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * The roles an admin holds, read on every authenticated request — the
   * primary key's leading column serves it.
   */
  async findRoles(
    adminUserId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminRoleName[]> {
    const rows = await executor
      .select({ role: adminUserRoles.role })
      .from(adminUserRoles)
      .where(eq(adminUserRoles.adminUserId, adminUserId))
      .orderBy(adminUserRoles.role);
    return rows.map((row) => row.role);
  }

  async findSessionById(id: string): Promise<AdminSessionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, id))
      .limit(1);
    return row;
  }

  /**
   * Opens a session — for sign-in (`AdminSignInService`) and for the tests
   * that exercise the admin surface with a bearer token.
   */
  async createSession(
    adminUserId: string,
    expiresAt: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminSessionRow> {
    const [row] = await executor
      .insert(adminSessions)
      .values({ id: uuidV7(), adminUserId, expiresAt })
      .returning();
    if (row === undefined) {
      throw new Error('Insert of admin_sessions returned no row.');
    }
    return row;
  }

  /**
   * Moves `last_used_at` forward, which is what the idle timeout is measured
   * against.
   *
   * Written on every authenticated admin request. It is one narrow UPDATE by
   * primary key on a table with a handful of rows, and the alternative — an
   * idle timeout computed from something not written down — is not an idle
   * timeout.
   */
  async touchSession(id: string, now: Date, executor: DatabaseExecutor = this.db): Promise<void> {
    await executor
      .update(adminSessions)
      .set({ lastUsedAt: now })
      .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    await this.db
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt)));
  }

  /**
   * Appends to the audit trail.
   *
   * Insert-only by construction: `0009_admin_identity.sql` installs a trigger
   * that raises on UPDATE, DELETE and TRUNCATE, so there is no method here
   * that could attempt one and no query elsewhere that could succeed at one.
   */
  async appendAudit(
    entry: AuditEntry,
    now: Date = new Date(),
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor.insert(adminAuditLog).values({
      id: uuidV7(),
      adminUserId: entry.adminUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      createdAt: now,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.before === undefined ? {} : { before: entry.before }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
    });
  }

  /** Newest first — "everything that was done to this master". */
  async listAuditForTarget(
    targetType: string,
    targetId: string,
    limit: number,
  ): Promise<{ action: string; reason: string | null; createdAt: Date; adminUserId: string }[]> {
    return this.db
      .select({
        action: adminAuditLog.action,
        reason: adminAuditLog.reason,
        createdAt: adminAuditLog.createdAt,
        adminUserId: adminAuditLog.adminUserId,
      })
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.targetType, targetType), eq(adminAuditLog.targetId, targetId)))
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(limit);
  }

  /**
   * Provisioning, for the seed path and for tests.
   *
   * `lower()` on the way in rather than trusting the caller: the CHECK
   * constraint refuses a mixed-case address outright, and turning that into a
   * constraint violation for a legitimate "Admin@tezusta.az" would be a
   * needlessly hostile way to enforce a rule the database can simply apply.
   */
  async createAdmin(
    input: {
      email: string;
      displayName: string;
      /**
       * Required, with no default. An admin created without saying what they
       * may do is exactly the mistake a default would hide — `super_admin` as a
       * default is a privilege nobody chose, and `[]` is an account that can do
       * nothing and looks broken (ADR-0043 § 1).
       */
      roles: readonly AdminRoleName[];
      grantedByAdminId?: string | undefined;
    },
    executor?: DatabaseExecutor,
  ): Promise<AdminUserRow> {
    const write = async (tx: DatabaseExecutor): Promise<AdminUserRow> => {
      const [row] = await tx
        .insert(adminUsers)
        .values({
          id: uuidV7(),
          email: input.email.trim().toLowerCase(),
          displayName: input.displayName,
        })
        .returning();
      if (row === undefined) {
        throw new Error('Insert of admin_users returned no row.');
      }
      await this.grantRoles(row.id, input.roles, input.grantedByAdminId ?? null, tx);
      return row;
    };
    // The account and its roles land together or not at all: an admin row
    // with no roles is a half-provisioned account.
    return executor === undefined ? this.db.transaction(write) : write(executor);
  }

  /** A live admin by email — the email is stored lower-cased (see `createAdmin`). */
  async findLiveAdminByEmail(
    email: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminUserRow | undefined> {
    const [row] = await executor
      .select()
      .from(adminUsers)
      .where(and(eq(adminUsers.email, email.trim().toLowerCase()), isNull(adminUsers.deletedAt)))
      .limit(1);
    return row;
  }

  /** How many live, active admins hold `super_admin`. */
  async countActiveSuperAdmins(executor: DatabaseExecutor = this.db): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(adminUserRoles)
      .innerJoin(adminUsers, eq(adminUsers.id, adminUserRoles.adminUserId))
      .where(
        and(
          eq(adminUserRoles.role, 'super_admin'),
          eq(adminUsers.status, 'active'),
          isNull(adminUsers.deletedAt),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Replaces any live invitation for this admin with a new one (ADR-0043 § 3).
   * Two live links for one account would be two credentials in circulation,
   * so the older ones are revoked in the same transaction.
   */
  async replaceInvitation(
    input: {
      adminUserId: string;
      tokenHash: string;
      createdByAdminId: string | null;
      expiresAt: Date;
    },
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminInvitationRow> {
    await executor
      .update(adminInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(adminInvitations.adminUserId, input.adminUserId),
          isNull(adminInvitations.usedAt),
          isNull(adminInvitations.revokedAt),
        ),
      );
    const [row] = await executor
      .insert(adminInvitations)
      .values({ id: uuidV7(), ...input, createdAt: now })
      .returning();
    if (row === undefined) {
      throw new Error('Insert of admin_invitations returned no row.');
    }
    return row;
  }

  /**
   * The invitation behind a token digest, with its admin, if the link is
   * still usable: unused, unrevoked, unexpired, for a live and active admin.
   * Every other case is `undefined` — the caller answers them all alike.
   *
   * `lock` takes `FOR UPDATE` on the invitation, so two submissions of one
   * link cannot both complete setup.
   */
  async findUsableInvitation(
    tokenHash: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
    lock = false,
  ): Promise<{ invitation: AdminInvitationRow; admin: AdminUserRow } | undefined> {
    const query = executor
      .select({ invitation: adminInvitations, admin: adminUsers })
      .from(adminInvitations)
      .innerJoin(adminUsers, eq(adminUsers.id, adminInvitations.adminUserId))
      .where(
        and(
          eq(adminInvitations.tokenHash, tokenHash),
          isNull(adminInvitations.usedAt),
          isNull(adminInvitations.revokedAt),
          gt(adminInvitations.expiresAt, now),
          eq(adminUsers.status, 'active'),
          isNull(adminUsers.deletedAt),
        ),
      )
      .limit(1);
    const [row] = lock ? await query.for('update', { of: adminInvitations }) : await query;
    return row;
  }

  /**
   * Writes a completed setup: the password, the sealed secret, the step that
   * proved it, the invitation spent, and every existing session revoked — a
   * reset is a new credential, and sessions opened under the old one end.
   */
  async completeSetup(
    input: {
      adminUserId: string;
      invitationId: string;
      passwordHash: string;
      totpSecretEncrypted: string;
      lastTotpStep: number;
    },
    now: Date,
    executor: DatabaseExecutor,
  ): Promise<void> {
    await executor
      .update(adminUsers)
      .set({
        passwordHash: input.passwordHash,
        totpSecretEncrypted: input.totpSecretEncrypted,
        totpEnrolledAt: now,
        lastTotpStep: input.lastTotpStep,
        credentialsChangedAt: now,
      })
      .where(eq(adminUsers.id, input.adminUserId));
    await executor
      .update(adminInvitations)
      .set({ usedAt: now })
      .where(eq(adminInvitations.id, input.invitationId));
    await this.revokeAllSessions(input.adminUserId, now, executor);
  }

  /**
   * Clears a password and second factor so the account can only be used again
   * through a new setup link (a super_admin's reset, or `--reissue`).
   */
  async clearCredentials(
    adminUserId: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(adminUsers)
      .set({
        passwordHash: null,
        totpSecretEncrypted: null,
        totpEnrolledAt: null,
        lastTotpStep: null,
        credentialsChangedAt: now,
      })
      .where(eq(adminUsers.id, adminUserId));
    await this.revokeAllSessions(adminUserId, now, executor);
  }

  async revokeAllSessions(
    adminUserId: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(and(eq(adminSessions.adminUserId, adminUserId), isNull(adminSessions.revokedAt)));
  }

  /** Grants roles, for the bootstrap command. Existing grants are left alone. */
  async grantRoles(
    adminUserId: string,
    roles: readonly AdminRoleName[],
    grantedByAdminId: string | null,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    if (roles.length === 0) {
      return;
    }
    await executor
      .insert(adminUserRoles)
      .values(roles.map((role) => ({ adminUserId, role, grantedByAdminId })))
      .onConflictDoNothing();
  }

  /**
   * Takes a TOTP step for this admin if it is newer than the last one taken.
   * `false` means another sign-in already used this step (or a later one).
   */
  async claimTotpStep(adminUserId: string, step: number): Promise<boolean> {
    const rows = await this.db
      .update(adminUsers)
      .set({ lastTotpStep: step })
      .where(
        and(
          eq(adminUsers.id, adminUserId),
          or(isNull(adminUsers.lastTotpStep), lt(adminUsers.lastTotpStep, step)),
        ),
      )
      .returning({ id: adminUsers.id });
    return rows.length === 1;
  }

  /** A rehash on sign-in after the scrypt cost was raised. */
  async updatePasswordHash(adminUserId: string, passwordHash: string): Promise<void> {
    await this.db.update(adminUsers).set({ passwordHash }).where(eq(adminUsers.id, adminUserId));
  }

  async insertRefreshToken(
    sessionId: string,
    tokenHash: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .insert(adminRefreshTokens)
      .values({ id: uuidV7(), sessionId, tokenHash, createdAt: now });
  }

  /** The refresh token behind a digest and its session, row-locked. */
  async findRefreshTokenForUpdate(
    tokenHash: string,
    executor: DatabaseExecutor,
  ): Promise<{ token: AdminRefreshTokenRow; session: AdminSessionRow } | undefined> {
    const [row] = await executor
      .select({ token: adminRefreshTokens, session: adminSessions })
      .from(adminRefreshTokens)
      .innerJoin(adminSessions, eq(adminSessions.id, adminRefreshTokens.sessionId))
      .where(eq(adminRefreshTokens.tokenHash, tokenHash))
      .limit(1)
      .for('update', { of: adminRefreshTokens });
    return row;
  }

  async markRefreshTokenRotated(id: string, now: Date, executor: DatabaseExecutor): Promise<void> {
    await executor
      .update(adminRefreshTokens)
      .set({ rotatedAt: now })
      .where(eq(adminRefreshTokens.id, id));
  }

  /** Ends a session and every refresh token in its chain. */
  async revokeSessionAndTokens(
    sessionId: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(adminSessions)
      .set({ revokedAt: now })
      .where(and(eq(adminSessions.id, sessionId), isNull(adminSessions.revokedAt)));
    await executor
      .update(adminRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(adminRefreshTokens.sessionId, sessionId), isNull(adminRefreshTokens.revokedAt)),
      );
  }

  /**
   * Deletes up to `limit` admin refresh tokens whose **session** is past
   * `cutoff` — expired, or revoked that long ago (#276). One bounded batch of
   * the retention sweep `MaintenanceService` runs on `AUTH_RETENTION_DAYS`,
   * the same window and the same job the consumer path's
   * `SessionsRepository.deleteExpiredRefreshTokens` uses.
   *
   * **The cutoff is the session's, not the token's**, because
   * `admin_refresh_tokens` carries no `expires_at` of its own — unlike the
   * consumer `refresh_tokens`, an admin token's lifetime is entirely its
   * session's (ADR-0043 § 4: 8-hour families, no independent token TTL). A
   * token therefore goes when the session it belongs to is old enough, joined
   * rather than read from its own row.
   *
   * There is no admin equivalent of the consumer sweep's `incidentCutoff`:
   * `admin_sessions` carries no `revoked_reason` and no reuse-detection
   * concept (ADR-0027 is a consumer-path decision), so one window covers
   * every admin session.
   *
   * Bounded with a subquery rather than `DELETE … LIMIT`, matching
   * `SessionsRepository.deleteExpiredRefreshTokens` — one iteration cannot
   * hold a long transaction on the table the refresh path writes to on every
   * rotation.
   */
  async deleteExpiredRefreshTokens(cutoff: Date, limit: number): Promise<number> {
    const deleted = await this.db.execute<{ id: string }>(
      sql`delete from ${adminRefreshTokens}
          where ${adminRefreshTokens.id} = any(array(
            select ${adminRefreshTokens.id}
            from ${adminRefreshTokens}
            join ${adminSessions} on ${adminSessions.id} = ${adminRefreshTokens.sessionId}
            where ${adminSessions.expiresAt} <= ${cutoff}::timestamptz
               or ${adminSessions.revokedAt} <= ${cutoff}::timestamptz
            limit ${limit}
          ))
          returning ${adminRefreshTokens.id}`,
    );
    return deleted.rows.length;
  }

  /**
   * Deletes up to `limit` admin sessions that are past `cutoff` — expired, or
   * revoked that long ago — and that no refresh token still points at (#276).
   *
   * **The `not exists` is not belt and braces.**
   * `admin_refresh_tokens.session_id` is `ON DELETE RESTRICT`, so a session
   * with tokens left cannot be deleted at all — without the clause this
   * statement would not leave orphans, it would raise. Ordering the two
   * sweeps (tokens first, sessions second, in `MaintenanceService`) is what
   * makes a session disappear over two iterations rather than never, mirroring
   * `SessionsRepository.deleteRetiredSessions`.
   */
  async deleteRetiredSessions(cutoff: Date, limit: number): Promise<number> {
    const deleted = await this.db.execute<{ id: string }>(
      sql`delete from ${adminSessions}
          where ${adminSessions.id} = any(array(
            select ${adminSessions.id} from ${adminSessions}
            where (${adminSessions.expiresAt} <= ${cutoff}::timestamptz
                   or ${adminSessions.revokedAt} <= ${cutoff}::timestamptz)
              and not exists (
                select 1 from ${adminRefreshTokens}
                where ${adminRefreshTokens.sessionId} = ${adminSessions.id}
              )
            limit ${limit}
          ))
          returning ${adminSessions.id}`,
    );
    return deleted.rows.length;
  }

  /**
   * The audit trail, newest first, resumed after `afterId` (issue #243).
   *
   * Served by `admin_audit_log_actor_idx` when filtered by actor,
   * `admin_audit_log_target_idx` when filtered by target, and
   * `admin_audit_log_created_idx` otherwise. The keyset position is resolved
   * from the row the cursor names, like every cursor in this codebase.
   */
  async listAudit(input: {
    readonly actorId?: string | undefined;
    readonly targetType?: string | undefined;
    readonly targetId?: string | undefined;
    readonly actionPrefix?: string | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<{
    rows: {
      entry: typeof adminAuditLog.$inferSelect;
      actor: { id: string; email: string; displayName: string };
    }[];
    hasMore: boolean;
  }> {
    const rows = await this.db
      .select({
        entry: adminAuditLog,
        actor: { id: adminUsers.id, email: adminUsers.email, displayName: adminUsers.displayName },
      })
      .from(adminAuditLog)
      .innerJoin(adminUsers, eq(adminUsers.id, adminAuditLog.adminUserId))
      .where(
        and(
          input.actorId === undefined ? undefined : eq(adminAuditLog.adminUserId, input.actorId),
          input.targetType === undefined
            ? undefined
            : eq(adminAuditLog.targetType, input.targetType),
          input.targetId === undefined ? undefined : eq(adminAuditLog.targetId, input.targetId),
          // Whole segments only: `master` must not match `masters.x`. The
          // prefix is validated to [a-z0-9_.], and `starts_with` treats `_`
          // literally where LIKE would not.
          input.actionPrefix === undefined
            ? undefined
            : sql`(${adminAuditLog.action} = ${input.actionPrefix}
                   or starts_with(${adminAuditLog.action}, ${`${input.actionPrefix}.`}))`,
          input.from === undefined ? undefined : gte(adminAuditLog.createdAt, input.from),
          input.to === undefined ? undefined : lt(adminAuditLog.createdAt, input.to),
          input.afterId === null
            ? undefined
            : sql`(${adminAuditLog.createdAt}, ${adminAuditLog.id}) < (
                select a.created_at, a.id from admin_audit_log a where a.id = ${input.afterId}
              )`,
        ),
      )
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(input.limit + 1);
    return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }

  /**
   * Serialises every change to who is an admin and what they hold (#242), so
   * "is there another active super_admin?" is answered and acted on as one
   * step. Transaction-scoped: released at commit or rollback.
   */
  async lockRoster(executor: DatabaseExecutor): Promise<void> {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtext('tezusta:admin-roster'))`);
  }

  async setStatus(
    adminUserId: string,
    status: AdminUserStatusName,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor.update(adminUsers).set({ status }).where(eq(adminUsers.id, adminUserId));
  }

  async revokeLiveInvitations(
    adminUserId: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(adminInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(adminInvitations.adminUserId, adminUserId),
          isNull(adminInvitations.usedAt),
          isNull(adminInvitations.revokedAt),
        ),
      );
  }

  /** Replaces an admin's roles with exactly `roles`. */
  async replaceRoles(
    adminUserId: string,
    roles: readonly AdminRoleName[],
    grantedByAdminId: string,
    executor: DatabaseExecutor,
  ): Promise<void> {
    await executor.delete(adminUserRoles).where(eq(adminUserRoles.adminUserId, adminUserId));
    await this.grantRoles(adminUserId, roles, grantedByAdminId, executor);
  }

  /** Every live admin account for the management screen — a handful of rows. */
  async listAccounts(
    executor: DatabaseExecutor = this.db,
    onlyId?: string,
  ): Promise<AdminAccount[]> {
    const rows = await executor
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        displayName: adminUsers.displayName,
        status: adminUsers.status,
        enrolledAt: adminUsers.totpEnrolledAt,
        createdAt: adminUsers.createdAt,
        // `admin_users.id` is written out: Drizzle renders a column of the
        // outer table unqualified, and inside a subquery over a table with its
        // own `id` that would bind to the wrong one.
        // JSON rather than an enum array: node-postgres has no parser for
        // `admin_role[]` and would hand back the literal '{a,b}' string.
        roles: sql<AdminRoleName[]>`coalesce(
          (select json_agg(r.role order by r.role) from admin_user_roles r
            where r.admin_user_id = admin_users.id),
          '[]'::json)`,
        invitationPending: sql<boolean>`exists (
          select 1 from admin_invitations i
           where i.admin_user_id = admin_users.id
             and i.used_at is null and i.revoked_at is null and i.expires_at > now())`,
      })
      .from(adminUsers)
      .where(
        and(
          isNull(adminUsers.deletedAt),
          onlyId === undefined ? undefined : eq(adminUsers.id, onlyId),
        ),
      )
      .orderBy(adminUsers.displayName, adminUsers.id);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      status: row.status,
      roles: row.roles,
      enrolled: row.enrolledAt !== null,
      invitationPending: row.invitationPending,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async findAccount(
    adminUserId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<AdminAccount | undefined> {
    const [account] = await this.listAccounts(executor, adminUserId);
    return account;
  }

  /** Runs `work` in one transaction. */
  async transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** Count of audit rows for a target — used by tests and by nothing else yet. */
  async countAuditForTarget(targetType: string, targetId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.targetType, targetType), eq(adminAuditLog.targetId, targetId)));
    return row?.count ?? 0;
  }
}
