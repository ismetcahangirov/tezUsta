import { Inject, Injectable } from '@nestjs/common';

import { uuidV7 } from '../../common/ids/uuid-v7';
import type { UserRoleName } from '../../infra/database/schema/users';
import type { AuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import type { DeviceInfo, TokenPair } from './auth.types';
import { SessionsRepository } from './sessions.repository';
import { TokenService } from './token.service';

/** Who the session is for, plus whatever the client said about the device. */
export interface StartSessionInput {
  readonly userId: string;
  readonly roles: readonly UserRoleName[];
  readonly device?: DeviceInfo | undefined;
}

/**
 * Owns the stateful half of the token model: which device sessions exist, when
 * they end, and which refresh token is currently live for each
 * (`docs/architecture/authentication.md` § Sessions and devices).
 *
 * Sign-in itself is not here. OTP verification (issue #29) proves the phone
 * number and then calls {@link startSession}; the admin path (EPIC 13) will
 * prove a different credential and must not reach this service at all, because
 * the two token families deliberately share no issuer and no refresh family
 * (ADR-0014).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly tokens: TokenService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Opens a device session and returns the first access/refresh pair.
   *
   * The session's `expires_at` is set once, here, from `JWT_REFRESH_TTL`, and
   * rotation never extends it — otherwise a client that refreshes every
   * fifteen minutes would hold a session that never ends, and "30-day refresh
   * token" would describe nothing.
   */
  async startSession(input: StartSessionInput, now: Date = new Date()): Promise<TokenPair> {
    const sessionId = uuidV7();
    const refreshTokenExpiresAt = new Date(now.getTime() + this.config.refreshTtlMs);
    const minted = this.tokens.mintRefreshToken();

    await this.sessions.create({
      sessionId,
      userId: input.userId,
      deviceId: input.device?.deviceId,
      userAgent: input.device?.userAgent,
      sessionExpiresAt: refreshTokenExpiresAt,
      refreshTokenId: minted.id,
      refreshTokenHash: minted.tokenHash,
    });

    const access = this.tokens.issueAccessToken(
      { userId: input.userId, sessionId, roles: input.roles },
      now,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: minted.token,
      refreshTokenExpiresAt,
    };
  }
}
