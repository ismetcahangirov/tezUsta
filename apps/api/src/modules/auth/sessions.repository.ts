import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type {
  RefreshTokenRow,
  SessionRevokedReasonName,
  SessionRow,
} from '../../infra/database/schema/sessions';
import { refreshTokens, sessions } from '../../infra/database/schema/sessions';

/** What `create` needs in order to write both rows. */
export interface NewSessionInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly deviceId?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly sessionExpiresAt: Date;
  readonly refreshTokenId: string;
  readonly refreshTokenHash: string;
}

/**
 * Drizzle queries over `sessions` and `refresh_tokens`. No policy lives here —
 * how long a session lasts and what a replay means are decisions for the
 * service (`docs/architecture/backend-architecture.md` § Module rules).
 */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Opens a device session and issues its first refresh token, in one
   * transaction.
   *
   * A session with no refresh token is a row nobody can ever use, and a
   * refresh token whose session was never committed is a credential pointing
   * at nothing. Both rows commit together or neither does.
   */
  async create(input: NewSessionInput): Promise<{ session: SessionRow; token: RefreshTokenRow }> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          id: input.sessionId,
          userId: input.userId,
          // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
          // optional property, and Drizzle treats an absent key as "use the
          // column default" — which for a nullable column is NULL, exactly
          // what an unsupplied device id means.
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
          ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
          expiresAt: input.sessionExpiresAt,
        })
        .returning();

      if (session === undefined) {
        throw new Error('Insert into sessions returned no row.');
      }

      const [token] = await tx
        .insert(refreshTokens)
        .values({
          id: input.refreshTokenId,
          sessionId: input.sessionId,
          tokenHash: input.refreshTokenHash,
          // The token cannot outlive its family: the session's absolute expiry
          // is the ceiling, and rotation never raises it.
          expiresAt: input.sessionExpiresAt,
        })
        .returning();

      if (token === undefined) {
        throw new Error('Insert into refresh_tokens returned no row.');
      }

      return { session, token };
    });
  }

  /**
   * The read on the hot path: every authenticated request resolves its token's
   * `sid` through here, because an access token is self-contained and therefore
   * cannot tell the server that its session was revoked in the meantime
   * (`docs/architecture/authentication.md` § Why a short access token).
   *
   * Returns the whole row rather than a `boolean`, deliberately. Whether a
   * session is usable is three conditions — it exists, it is not revoked, it
   * has not passed its absolute expiry — plus the `user_id` the token's `sub`
   * must match, and collapsing them here would put that policy in a repository
   * (`docs/architecture/backend-architecture.md` § Module rules) and hand the
   * caller a `false` it cannot log a reason for. One indexed primary-key
   * lookup either way.
   */
  async findSessionById(id: string): Promise<SessionRow | undefined> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row;
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRow | undefined> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id))
      .limit(1);
    return row;
  }

  /**
   * Marks a refresh token spent, and reports whether **this** call is the one
   * that did it.
   *
   * The `used_at IS NULL` predicate is evaluated by Postgres as part of the
   * write, not by us beforehand — which is the whole reason `refresh_tokens`
   * exists as its own table (see the comment on it). Two concurrent refreshes
   * presenting the same token both reach this statement; exactly one updates a
   * row and gets it back, and the other gets nothing. There is no window
   * between the check and the write for them to interleave in, and no lock to
   * take, time out, or forget to release.
   *
   * A read-then-write would be the natural-looking version and would be
   * wrong in the most damaging possible way: both callers would see
   * `used_at IS NULL`, both would rotate, and the loser's rotation would look
   * exactly like a stolen token being replayed — so the reuse detector would
   * revoke every session the user has, for nothing.
   */
  async consumeRefreshToken(id: string, now: Date): Promise<RefreshTokenRow | undefined> {
    const [row] = await this.db
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
      .returning();
    return row;
  }

  /**
   * Issues the next token in an existing family and records that the session
   * was used, in one transaction.
   *
   * `expires_at` is copied from the session rather than recomputed, so
   * rotation cannot extend the family past the absolute end set at sign-in.
   */
  async rotate(input: {
    sessionId: string;
    refreshTokenId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<RefreshTokenRow> {
    return this.db.transaction(async (tx) => {
      const [token] = await tx
        .insert(refreshTokens)
        .values({
          id: input.refreshTokenId,
          sessionId: input.sessionId,
          tokenHash: input.refreshTokenHash,
          expiresAt: input.expiresAt,
        })
        .returning();

      if (token === undefined) {
        throw new Error('Insert into refresh_tokens returned no row.');
      }

      await tx
        .update(sessions)
        .set({ lastUsedAt: input.now })
        .where(eq(sessions.id, input.sessionId));

      return token;
    });
  }

  /**
   * Revokes one session, and only if it is still live.
   *
   * `revoked_at IS NULL` in the predicate keeps the FIRST reason — a session
   * revoked for `reuse_detected` and then signed out normally a second later
   * must not have that recorded as an ordinary `logout`, because the reuse
   * event is the one anybody investigating needs to find.
   */
  async revokeSession(
    id: string,
    reason: SessionRevokedReasonName,
    now: Date,
  ): Promise<SessionRow | undefined> {
    const [row] = await this.db
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning();
    return row;
  }

  /**
   * Revokes every live session a user holds, and returns how many there were.
   *
   * One statement rather than a read followed by a loop of updates: a session
   * opened between the read and the writes would survive a "sign out
   * everywhere" that the user was told had succeeded. The count is returned
   * because the caller logs it — "revoked 4 sessions" is the difference
   * between a reuse alert somebody can act on and a line that says something
   * happened.
   */
  async revokeAllSessionsForUser(
    userId: string,
    reason: SessionRevokedReasonName,
    now: Date,
  ): Promise<number> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length;
  }

  /**
   * The user's live device sessions, most recently used first.
   *
   * Filters on both conditions that make a session usable — not revoked, and
   * not past its absolute expiry — because a device list that shows a session
   * which can no longer refresh invites the user to "sign out" something that
   * is already gone, and to trust the list less the next time.
   */
  async listActiveSessionsForUser(userId: string, now: Date): Promise<readonly SessionRow[]> {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
      )
      .orderBy(desc(sessions.lastUsedAt));
  }
}
