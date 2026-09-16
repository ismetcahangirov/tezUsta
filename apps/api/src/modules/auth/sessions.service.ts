import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { UsersRepository } from '../users/users.repository';
import type { AuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import type { DeviceInfo, TokenPair } from './auth.types';
import { SessionsRepository } from './sessions.repository';
import { TokenService } from './token.service';

/**
 * Raised when the account exists but may not open a session — suspended by an
 * admin, or soft-deleted.
 *
 * Not an enumeration risk at this point in the flow: on the consumer path a
 * session is only ever started after OTP verification has proven the caller
 * owns the number, so they already know the account exists. The endpoint that
 * must answer identically for known and unknown numbers is the OTP *request*
 * (issue #29), which never reaches this service.
 */
export class AccountNotActiveError extends AppError {
  constructor() {
    super(ERROR_CODES.FORBIDDEN, 'This account is not active.', 403);
    this.name = 'AccountNotActiveError';
    Object.setPrototypeOf(this, AccountNotActiveError.prototype);
  }
}

/**
 * Who the session is for, plus whatever the client said about the device.
 *
 * Deliberately **no `roles` field.** Roles are read from the database inside
 * {@link SessionsService.startSession}; letting a caller pass them in would
 * make "mint a master token for a user who holds no master grant" a
 * one-argument mistake, in the one place where a mistake is a privilege
 * escalation.
 */
export interface StartSessionInput {
  readonly userId: string;
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
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Opens a device session and returns the first access/refresh pair.
   *
   * Status and roles come from the database here, not from the caller. A
   * suspended account cannot open a new session at all, which is the other
   * half of the guarantee in `docs/architecture/authentication.md`: an
   * existing access token stays valid for at most fifteen minutes after
   * suspension, and no new one is ever minted.
   *
   * The session's `expires_at` is set once, here, from `JWT_REFRESH_TTL`, and
   * rotation never extends it — otherwise a client that refreshes every
   * fifteen minutes would hold a session that never ends, and "30-day refresh
   * token" would describe nothing.
   */
  async startSession(input: StartSessionInput, now: Date = new Date()): Promise<TokenPair> {
    const found = await this.users.findByIdWithRoles(input.userId);
    if (found === undefined) {
      // Soft-deleted or never existed. Both are "there is nobody to open a
      // session for", and the caller (OTP verification) has already decided
      // what the client is told.
      throw new AccountNotActiveError();
    }
    if (found.user.status !== 'active') {
      throw new AccountNotActiveError();
    }

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
      { userId: input.userId, sessionId, roles: found.roles },
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
