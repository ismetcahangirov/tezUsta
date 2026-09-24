import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { AdminSessionRow, AdminUserRow } from '../../infra/database/schema/admin';
import { adminAuditLog, adminSessions, adminUsers } from '../../infra/database/schema/admin';

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
  async createAdmin(input: { email: string; displayName: string }): Promise<AdminUserRow> {
    const [row] = await this.db
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
    return row;
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
