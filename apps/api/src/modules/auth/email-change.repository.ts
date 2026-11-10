import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import { accountRecoveryRequests } from '../../infra/database/schema/account-recovery';
import type {
  EmailChangeInvalidationReasonName,
  EmailChangeRow,
} from '../../infra/database/schema/email-changes';
import { emailChanges } from '../../infra/database/schema/email-changes';
import { users } from '../../infra/database/schema/users';

export interface NewEmailChangeInput {
  readonly id: string;
  readonly userId: string;
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly currentCodeHash: string;
  readonly newCodeHash: string;
  readonly expiresAt: Date;
}

/**
 * Drizzle queries over `email_changes` (#514), and no policy.
 *
 * Every statement filters on **liveness** (`completed_at IS NULL AND
 * invalidated_at IS NULL`) itself, for the reason `OtpRepository` gives: a
 * spent change must behave as absent to every caller.
 */
@Injectable()
export class EmailChangeRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Supersedes the user's live change, if any, and writes the new one, in one
   * transaction. Retried once on a unique violation, exactly as
   * `OtpRepository.replaceLiveChallenge` is and for the same proven reason: the
   * retry runs after the winner committed, so its supersede finds that row.
   *
   * Answers `recovery-pending`, writing nothing, while support has a recovery
   * open on the account (#515). The account's `users` row is locked first, as
   * opening a recovery locks it, so the two cannot both pass their checks.
   */
  async replaceLive(
    input: NewEmailChangeInput,
    now: Date,
  ): Promise<EmailChangeRow | 'recovery-pending'> {
    try {
      return await this.write(input, now);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return await this.write(input, now);
    }
  }

  private async write(
    input: NewEmailChangeInput,
    now: Date,
  ): Promise<EmailChangeRow | 'recovery-pending'> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${users} where ${users.id} = ${input.userId} for update`);
      const [recovery] = await tx
        .select({ id: accountRecoveryRequests.id })
        .from(accountRecoveryRequests)
        .where(
          and(
            eq(accountRecoveryRequests.userId, input.userId),
            isNull(accountRecoveryRequests.cancelledAt),
            isNull(accountRecoveryRequests.movedAt),
          ),
        )
        .limit(1);
      if (recovery !== undefined) {
        return 'recovery-pending';
      }

      await tx
        .update(emailChanges)
        .set({ invalidatedAt: now, invalidatedReason: 'superseded' })
        .where(
          and(
            eq(emailChanges.userId, input.userId),
            isNull(emailChanges.completedAt),
            isNull(emailChanges.invalidatedAt),
          ),
        );

      const [created] = await tx.insert(emailChanges).values(input).returning();
      if (created === undefined) {
        throw new Error('Insert into email_changes returned no row.');
      }
      return created;
    });
  }

  /** The one change the user may currently confirm, if any. */
  async findLiveForUser(userId: string, now: Date): Promise<EmailChangeRow | undefined> {
    const [row] = await this.db
      .select()
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
    return row;
  }

  /**
   * Marks the change completed **only if both presented digests match** a live,
   * unexpired row. Returns the row, or `undefined` when nothing matched.
   *
   * Both hashes, liveness and expiry sit in the one `WHERE` of the write, so two
   * concurrent confirms cannot both pass: the loser re-evaluates the predicate
   * against the completed row and matches nothing. Runs on the caller's
   * transaction, because completing the change and moving the address must
   * commit or roll back together.
   */
  async complete(
    id: string,
    currentCodeHash: string,
    newCodeHash: string,
    now: Date,
    executor: DatabaseExecutor,
  ): Promise<EmailChangeRow | undefined> {
    const [row] = await executor
      .update(emailChanges)
      .set({ completedAt: now })
      .where(
        and(
          eq(emailChanges.id, id),
          eq(emailChanges.currentCodeHash, currentCodeHash),
          eq(emailChanges.newCodeHash, newCodeHash),
          isNull(emailChanges.completedAt),
          isNull(emailChanges.invalidatedAt),
          gt(emailChanges.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }

  /** Retires a change that will never complete. Conditional on liveness, like `OtpRepository.invalidate`. */
  async invalidate(
    id: string,
    reason: EmailChangeInvalidationReasonName,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(emailChanges)
      .set({ invalidatedAt: now, invalidatedReason: reason })
      .where(
        and(
          eq(emailChanges.id, id),
          isNull(emailChanges.completedAt),
          isNull(emailChanges.invalidatedAt),
        ),
      );
  }
}
