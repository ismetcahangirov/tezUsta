import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { UserRoleName, UserRow } from '../../infra/database/schema/users';
import { userRoles, users } from '../../infra/database/schema/users';

/** A user together with the role set that authorization actually reads. */
export interface UserWithRoles {
  readonly user: UserRow;
  readonly roles: readonly UserRoleName[];
}

/**
 * Drizzle queries over `users` and `user_roles`, and nothing else — no
 * business rules, no HTTP, no transaction policy
 * (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * Every read filters `deleted_at IS NULL`. A soft-deleted account must behave
 * as absent to every caller; leaving that filter to each call site is how a
 * deleted user eventually signs back in.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Creates the account and its initial role grants in one transaction.
   *
   * The two writes are not independent: a `users` row with no `user_roles` row
   * is an account that can authenticate and then do nothing, and a
   * `user_roles` row with no user is impossible only because of the foreign
   * key. Committing them together means no request ever observes the
   * in-between state.
   */
  async create(input: {
    phoneE164: string;
    roles: readonly UserRoleName[];
  }): Promise<UserWithRoles> {
    const id = uuidV7();

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ id, phoneE164: input.phoneE164 })
        .returning();

      if (created === undefined) {
        // Unreachable: an INSERT ... RETURNING that inserts one row returns
        // one row, and a constraint violation throws instead. Present so the
        // narrowing is explicit rather than an assertion.
        throw new Error('Insert into users returned no row.');
      }

      if (input.roles.length > 0) {
        await tx.insert(userRoles).values(input.roles.map((role) => ({ userId: id, role })));
      }

      return { user: created, roles: [...input.roles] };
    });
  }

  /** Grants a role, ignoring a grant the user already holds. */
  async grantRole(userId: string, role: UserRoleName): Promise<void> {
    await this.db.insert(userRoles).values({ userId, role }).onConflictDoNothing();
  }

  async findByPhone(phoneE164: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.phoneE164, phoneE164), isNull(users.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * The read every authorization decision makes: current status and current
   * roles, from the database, never from a token claim
   * (`docs/architecture/authentication.md` § Role claims are a cache, not an
   * authority).
   */
  async findByIdWithRoles(id: string): Promise<UserWithRoles | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);

    if (user === undefined) {
      return undefined;
    }

    const grants = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, id));

    return { user, roles: grants.map((grant) => grant.role) };
  }
}
