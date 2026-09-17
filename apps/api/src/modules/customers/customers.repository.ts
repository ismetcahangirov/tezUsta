import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { CustomerRow } from '../../infra/database/schema/customers';
import { customers } from '../../infra/database/schema/customers';
import { UsersRepository } from '../users/users.repository';

/** Whether {@link CustomersRepository.createOrRevive} inserted a new row. */
export interface CreateOrReviveResult {
  readonly customer: CustomerRow;
  readonly created: boolean;
}

/**
 * Drizzle queries over `customers`, and nothing else — no business rules, no
 * HTTP, no transaction policy beyond the one atomicity requirement below
 * (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * Every read filters `deleted_at IS NULL`. A soft-deleted profile must behave
 * as absent to every caller, and leaving that filter to each call site is how
 * a deleted profile eventually answers a request.
 */
@Injectable()
export class CustomersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Creates the caller's profile, or brings back the one they soft-deleted,
   * and grants the `customer` role — all in one transaction.
   *
   * **Idempotent by construction rather than by checking first.** The unique
   * index on `user_id` is what makes "exactly one customer profile per
   * account" true; this method's job is to make the second request pleasant
   * rather than to be the thing enforcing it. A read-then-insert would be both
   * slower and wrong: two requests from the same account — a retried POST on a
   * flaky connection is the ordinary case, not an exotic one — would both read
   * "no profile" and both try to insert, and the loser would surface a
   * constraint violation as a 500.
   *
   * So the insert states the intent and the conflict clause answers it. An
   * empty `returning()` means the row already existed, at which point the row
   * is certainly there and the follow-up UPDATE cannot race anybody: it either
   * revives a soft-deleted profile or renames a live one, and both are what
   * "create my profile" means when a profile is already there.
   *
   * The role grant runs on the same transaction handle, so an account never
   * exists in the half-state where it has a profile the guards will not let it
   * use. Sign-up deliberately grants no role at all (`OtpService` creates the
   * user with `roles: []`) — the role is chosen afterwards, by this call.
   */
  async createOrRevive(input: {
    userId: string;
    displayName: string;
  }): Promise<CreateOrReviveResult> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(customers)
        .values({ id: uuidV7(), userId: input.userId, displayName: input.displayName })
        .onConflictDoNothing()
        .returning();

      if (inserted !== undefined) {
        await this.users.grantRole(input.userId, 'customer', tx);
        return { customer: inserted, created: true };
      }

      const [revived] = await tx
        .update(customers)
        // `deletedAt: null` unconditionally: reviving a soft-deleted profile
        // and renaming a live one are the same statement, and writing null
        // over a null costs nothing. Branching on the current value first
        // would add a read for no behavioural difference.
        .set({ displayName: input.displayName, deletedAt: null })
        .where(eq(customers.userId, input.userId))
        .returning();

      if (revived === undefined) {
        // Unreachable: the INSERT conflicted, so the row exists, and nothing
        // deletes from this table. Present so the narrowing is explicit
        // rather than an assertion.
        throw new Error('Customer row vanished between conflict and update.');
      }

      await this.users.grantRole(input.userId, 'customer', tx);
      return { customer: revived, created: false };
    });
  }

  async findByUserId(userId: string): Promise<CustomerRow | undefined> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.userId, userId), isNull(customers.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * By profile id, for the ownership-checked read. Returns the row without
   * judging who may see it — that decision belongs to the service, where
   * `requireVisibleOrNotFound` makes "does not exist" and "not yours" one
   * answer.
   */
  async findById(id: string): Promise<CustomerRow | undefined> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * `displayName?: string | undefined` rather than `displayName?: string`
   * because `exactOptionalPropertyTypes` makes those different types, and the
   * caller's value comes from a Zod `.optional()`, which produces the second.
   * Drizzle omits an absent key from the SET clause, and `updated_at` is
   * written by `$onUpdate` regardless, so a patch that turns out to be empty
   * is still valid SQL — the API boundary rejects it first anyway.
   */
  async updateByUserId(
    userId: string,
    patch: { displayName?: string | undefined },
  ): Promise<CustomerRow | undefined> {
    const [row] = await this.db
      .update(customers)
      .set(patch)
      .where(and(eq(customers.userId, userId), isNull(customers.deletedAt)))
      .returning();
    return row;
  }

  /**
   * Soft delete. Returns false when there was no live profile to delete, which
   * the service turns into the same 404 a stranger's id gets.
   *
   * `isNull(deletedAt)` in the WHERE is not redundant with the `set`: without
   * it, deleting twice would keep moving `deleted_at` forward, and the second
   * call would report success for work it did not do.
   */
  async softDeleteByUserId(userId: string): Promise<boolean> {
    const deleted = await this.db
      .update(customers)
      .set({ deletedAt: new Date() })
      .where(and(eq(customers.userId, userId), isNull(customers.deletedAt)))
      .returning({ id: customers.id });
    return deleted.length > 0;
  }
}
