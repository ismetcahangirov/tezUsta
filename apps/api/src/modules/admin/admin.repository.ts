import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type {
  AdminInvitationRow,
  AdminRoleName,
  AdminSessionRow,
  AdminUserRow,
} from '../../infra/database/schema/admin';
import {
  adminAuditLog,
  adminInvitations,
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
}

@Injectable()
export class AdminRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findLiveAdminById(id: string): Promise<AdminUserRow | undefined> {
    const [row] = await this.db
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
  async findRoles(adminUserId: string): Promise<AdminRoleName[]> {
    const rows = await this.db
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
   * Opens a session.
   *
   * There is no sign-in endpoint that calls this — credential issuance is
   * EPIC 13 (ADR-0014) — so today its callers are the provisioning path and
   * the tests that exercise the admin surface against a fixture admin, which
   * is exactly what that ADR said the interim state would be.
   */
  async createSession(adminUserId: string, expiresAt: Date): Promise<AdminSessionRow> {
    const [row] = await this.db
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
  async touchSession(id: string, now: Date): Promise<void> {
    await this.db
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
  async findLiveAdminByEmail(email: string): Promise<AdminUserRow | undefined> {
    const [row] = await this.db
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
