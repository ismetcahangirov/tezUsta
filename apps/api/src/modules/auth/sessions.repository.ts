import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { RefreshTokenRow, SessionRow } from '../../infra/database/schema/sessions';
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
}
