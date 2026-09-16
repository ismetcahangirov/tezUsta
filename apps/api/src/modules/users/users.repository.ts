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
    // One statement, not two. This runs on the hottest path in the API — every
    // authenticated request re-reads it, because a role claim in a token is a
    // cache and not an authority — so a second round trip would double the
    // latency of authorization itself. A LEFT JOIN (not an inner one) because
    // a user with no role grant yet is a real state: the account exists from
    // the moment OTP verification succeeds, and the role is chosen after.
    const rows = await this.db
      .select({ user: users, role: userRoles.role })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.id, id), isNull(users.deletedAt)));

    const first = rows[0];
    if (first === undefined) {
      return undefined;
    }

    return {
      user: first.user,
      // `flatMap` rather than `filter(...).map(...)` so the null the LEFT JOIN
      // produces for a role-less user is dropped without a cast.
      roles: rows.flatMap((row) => (row.role === null ? [] : [row.role])),
    };
  }
}
