import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNotNull, isNull, lte, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { AccountRecoveryRow } from '../../infra/database/schema/account-recovery';
import { accountRecoveryRequests } from '../../infra/database/schema/account-recovery';
import { adminUsers } from '../../infra/database/schema/admin';
import { customers } from '../../infra/database/schema/customers';
import { emailChanges } from '../../infra/database/schema/email-changes';
import { masters } from '../../infra/database/schema/masters';
import { users } from '../../infra/database/schema/users';

/**
 * A request with what the panel shows beside it: the account's profiles and
 * name, and the names of the admins who acted on it (#517).
 */
export interface AccountRecoveryView extends AccountRecoveryRow {
  readonly customerId: string | null;
  readonly masterId: string | null;
  readonly accountName: string | null;
  readonly openedByName: string | null;
  readonly cancelledByName: string | null;
  readonly approvedByName: string | null;
}

export interface RecoveryAccount {
  readonly userId: string;
  readonly email: string;
  readonly active: boolean;
}

export interface NewAccountRecovery {
  readonly id: string;
  readonly userId: string;
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly openedByAdminId: string;
  readonly evidenceNotes: string;
  readonly codeHash: string;
  readonly codeExpiresAt: Date;
  readonly createdAt: Date;
}

/** Still able to end in a move: neither cancelled nor moved. */
const isOpen = and(
  isNull(accountRecoveryRequests.cancelledAt),
  isNull(accountRecoveryRequests.movedAt),
);

const opener = alias(adminUsers, 'opener');
const canceller = alias(adminUsers, 'canceller');
const approver = alias(adminUsers, 'approver');

const viewColumns = {
  request: accountRecoveryRequests,
  customerId: customers.id,
  masterId: masters.id,
  // A master's own name where there is one: that is who support is talking to.
  accountName: sql<string | null>`coalesce(${masters.displayName}, ${customers.displayName})`,
  openedByName: opener.displayName,
  cancelledByName: canceller.displayName,
  approvedByName: approver.displayName,
};

type ViewRow = {
  readonly request: AccountRecoveryRow;
  readonly customerId: string | null;
  readonly masterId: string | null;
  readonly accountName: string | null;
  readonly openedByName: string | null;
  readonly cancelledByName: string | null;
  readonly approvedByName: string | null;
};

function toView({ request, ...rest }: ViewRow): AccountRecoveryView {
  return { ...request, ...rest };
}

/**
 * Drizzle queries over `account_recovery_requests` (#515), and no policy.
 *
 * Every state change is one conditional `UPDATE` whose `WHERE` names the state
 * it starts from, so two admins racing (cancel against approve, approve
 * against approve) leave exactly one of them holding a row.
 */
@Injectable()
export class AccountRecoveryRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /** The account behind a customer or master profile, or `undefined`. */
  async accountOf(
    kind: 'customer' | 'master',
    profileId: string,
  ): Promise<RecoveryAccount | undefined> {
    const profile = kind === 'customer' ? customers : masters;
    const [row] = await this.db
      .select({
        userId: users.id,
        email: users.email,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(profile)
      .innerJoin(users, eq(users.id, profile.userId))
      .where(eq(profile.id, profileId))
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    return {
      userId: row.userId,
      email: row.email,
      active: row.status === 'active' && row.deletedAt === null,
    };
  }

  /** Whether another live account signs in with this address. */
  async addressTaken(email: string, exceptUserId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt), ne(users.id, exceptUserId)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Holds the account's `users` row until the caller's transaction ends.
   *
   * Opening a recovery and starting a self-serve change each take it before
   * checking for the other, so the two cannot both pass their checks: the
   * second waits for the first to commit and then sees it.
   */
  async lockAccount(userId: string, executor: DatabaseExecutor): Promise<void> {
    await executor.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
  }

  async hasOpenRequest(userId: string, executor: DatabaseExecutor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ id: accountRecoveryRequests.id })
      .from(accountRecoveryRequests)
      .where(and(eq(accountRecoveryRequests.userId, userId), isOpen))
      .limit(1);
    return row !== undefined;
  }

  async hasLiveEmailChange(
    userId: string,
    now: Date,
    executor: DatabaseExecutor,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ id: emailChanges.id })
      .from(emailChanges)
      .where(
        and(
          eq(emailChanges.userId, userId),
          isNull(emailChanges.completedAt),
          isNull(emailChanges.invalidatedAt),
          gt(emailChanges.expiresAt, now),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async insert(input: NewAccountRecovery, executor: DatabaseExecutor): Promise<void> {
    await executor.insert(accountRecoveryRequests).values(input);
  }

  async find(id: string): Promise<AccountRecoveryView | undefined> {
    const [row] = await this.views(eq(accountRecoveryRequests.id, id)).limit(1);
    return row === undefined ? undefined : toView(row);
  }

  /** Every open request, oldest first: the order support works them in. */
  async listOpen(limit: number): Promise<AccountRecoveryView[]> {
    const rows = await this.views(isOpen).orderBy(accountRecoveryRequests.createdAt).limit(limit);
    return rows.map(toView);
  }

  private views(where: SQL | undefined) {
    return this.db
      .select(viewColumns)
      .from(accountRecoveryRequests)
      .leftJoin(customers, eq(customers.userId, accountRecoveryRequests.userId))
      .leftJoin(masters, eq(masters.userId, accountRecoveryRequests.userId))
      .leftJoin(opener, eq(opener.id, accountRecoveryRequests.openedByAdminId))
      .leftJoin(canceller, eq(canceller.id, accountRecoveryRequests.cancelledByAdminId))
      .leftJoin(approver, eq(approver.id, accountRecoveryRequests.approvedByAdminId))
      .where(where);
  }

  /** A fresh code for a request still waiting for one. */
  async replaceCode(
    id: string,
    codeHash: string,
    codeExpiresAt: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .update(accountRecoveryRequests)
      .set({ codeHash, codeExpiresAt })
      .where(
        and(
          eq(accountRecoveryRequests.id, id),
          isOpen,
          isNull(accountRecoveryRequests.codeVerifiedAt),
        ),
      )
      .returning({ id: accountRecoveryRequests.id });
    return rows.length > 0;
  }

  /**
   * Starts the hold **only if the presented digest matches** an open,
   * unverified request whose code has not expired. The digest, the state and
   * the expiry sit in the one `WHERE`, so a code is good once.
   */
  async verify(
    id: string,
    codeHash: string,
    now: Date,
    holdUntil: Date,
    cancelTokenHash: string,
    executor: DatabaseExecutor,
  ): Promise<AccountRecoveryRow | undefined> {
    const [row] = await executor
      .update(accountRecoveryRequests)
      .set({ codeVerifiedAt: now, holdUntil, cancelTokenHash })
      .where(
        and(
          eq(accountRecoveryRequests.id, id),
          eq(accountRecoveryRequests.codeHash, codeHash),
          gt(accountRecoveryRequests.codeExpiresAt, now),
          isNull(accountRecoveryRequests.codeVerifiedAt),
          isOpen,
        ),
      )
      .returning();
    return row;
  }

  /** Cancels an open request. `undefined` when it was not open. */
  async cancel(
    where: { readonly id: string } | { readonly cancelTokenHash: string },
    change: {
      readonly source: 'admin' | 'link' | 'code_attempts' | 'stale';
      readonly adminUserId?: string;
      readonly reason?: string;
      readonly now: Date;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<AccountRecoveryRow | undefined> {
    const target =
      'id' in where
        ? eq(accountRecoveryRequests.id, where.id)
        : // A link only exists once the hold has started; `isNotNull` keeps a
          // null digest from ever matching anything.
          and(
            isNotNull(accountRecoveryRequests.cancelTokenHash),
            eq(accountRecoveryRequests.cancelTokenHash, where.cancelTokenHash),
          );
    const [row] = await executor
      .update(accountRecoveryRequests)
      .set({
        cancelledAt: change.now,
        cancelSource: change.source,
        cancelledByAdminId: change.adminUserId ?? null,
        cancelReason: change.reason ?? null,
      })
      .where(and(target, isOpen))
      .returning();
    return row;
  }

  /**
   * Marks the request moved, by `approverId`, only while it is open, verified,
   * past its hold and opened by somebody else. The caller moves the address in
   * the same transaction.
   */
  async markMoved(
    id: string,
    approverId: string,
    reason: string,
    now: Date,
    executor: DatabaseExecutor,
  ): Promise<AccountRecoveryRow | undefined> {
    const [row] = await executor
      .update(accountRecoveryRequests)
      .set({ approvedByAdminId: approverId, approveReason: reason, movedAt: now })
      .where(
        and(
          eq(accountRecoveryRequests.id, id),
          isOpen,
          isNotNull(accountRecoveryRequests.codeVerifiedAt),
          lte(accountRecoveryRequests.holdUntil, now),
          ne(accountRecoveryRequests.openedByAdminId, approverId),
        ),
      )
      .returning();
    return row;
  }
}
