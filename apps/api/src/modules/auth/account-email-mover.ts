import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { isUniqueViolation } from '../../infra/database/database-error';
import type { DatabaseExecutor } from '../../infra/database/database.types';
import { users } from '../../infra/database/schema/users';
import { SessionsRepository } from './sessions.repository';

export interface AccountEmailMove {
  readonly userId: string;
  /** The address the caller believes the account has. The move is refused if it has changed since. */
  readonly fromEmail: string;
  /** Already normalised by `infra/email/email-address.ts`. */
  readonly toEmail: string;
  readonly now: Date;
}

/**
 * - `moved`: the address changed and every session of the user was revoked.
 * - `address-taken`: another live account holds `toEmail`.
 * - `stale`: the account is no longer active, or no longer has `fromEmail`.
 */
export type AccountEmailMoveResult = 'moved' | 'address-taken' | 'stale';

/**
 * **The one way an account's sign-in address changes**
 * ([ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md),
 * #514). The self-serve change calls it today; support-mediated recovery
 * (#515) is to call it too, so the two paths cannot drift on what a move does.
 *
 * It runs on the **caller's** transaction, so whatever the caller records
 * beside the move (the completed `email_changes` row; for #515, the admin
 * audit row) commits or rolls back with it.
 *
 * A move is a credential change: the address *is* the credential on the
 * consumer path, so every session of the user is revoked
 * (`docs/architecture/authentication.md` § Sessions and devices).
 *
 * The update runs inside a savepoint, so a unique violation on
 * `users_email_live_unique` answers `address-taken` and leaves the caller's
 * transaction usable, instead of aborting it.
 */
@Injectable()
export class AccountEmailMover {
  constructor(private readonly sessions: SessionsRepository) {}

  async move(input: AccountEmailMove, executor: DatabaseExecutor): Promise<AccountEmailMoveResult> {
    let moved: boolean;
    try {
      moved = await executor.transaction(async (savepoint) => {
        const [row] = await savepoint
          .update(users)
          .set({ email: input.toEmail })
          .where(
            and(
              eq(users.id, input.userId),
              eq(users.email, input.fromEmail),
              eq(users.status, 'active'),
              isNull(users.deletedAt),
            ),
          )
          .returning({ id: users.id });
        return row !== undefined;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return 'address-taken';
      }
      throw error;
    }

    if (!moved) {
      return 'stale';
    }

    await this.sessions.revokeAllSessionsForUser(input.userId, 'email_change', input.now, executor);
    return 'moved';
  }
}
