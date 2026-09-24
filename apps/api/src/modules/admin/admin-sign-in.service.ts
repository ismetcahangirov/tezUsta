import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminMe, AdminSignInRequest } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { AdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import { ADMIN_CONFIG } from './admin.types';
import { permissionsFor } from './admin-permissions';
import { digestToken, totpSecretContext } from './admin-setup.service';
import { AdminTokenService } from './admin-token.service';
import { hashPassword, needsRehash, verifyPassword } from './credentials/password-hash';
import { SecretBox, SecretBoxError } from './credentials/secret-box';
import { matchTotpStep } from './credentials/totp';

/**
 * The one 401 sign-in and refresh answer with (ADR-0043 § 4). Which factor
 * failed — or whether the account exists at all — goes to the log, never to
 * the caller: a sign-in form that says "password correct, code wrong" has told
 * an attacker the password.
 */
export class AdminSignInFailedError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super(ERROR_CODES.UNAUTHORIZED, 'Sign-in failed.', 401);
    this.name = 'AdminSignInFailedError';
    this.reason = reason;
    Object.setPrototypeOf(this, AdminSignInFailedError.prototype);
  }
}

/**
 * How long after a rotation a presentation of the old refresh token is taken
 * for a second tab refreshing at the same moment rather than for theft.
 * Cookies are shared across tabs, so the loser of that race already holds
 * the winner's fresh cookies; it is answered with success and no new cookies,
 * and nothing is revoked.
 */
const ROTATION_GRACE_MS = 10_000;
const REFRESH_TOKEN_BYTES = 32;

/** What the controller turns into cookies. */
export interface AdminSessionGrant {
  readonly me: AdminMe;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly sessionExpiresAt: Date;
}

export type AdminRefreshOutcome =
  | { readonly kind: 'rotated'; readonly grant: AdminSessionGrant }
  | { readonly kind: 'concurrent'; readonly me: AdminMe };

@Injectable()
export class AdminSignInService {
  private readonly logger = new Logger(AdminSignInService.name);
  private readonly box: SecretBox;
  /**
   * A real hash to verify against when there is no account, so an unknown
   * email costs the same scrypt as a known one. Computed once, lazily.
   */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly admins: AdminRepository,
    private readonly tokens: AdminTokenService,
    @Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig,
  ) {
    this.box = new SecretBox(config.totpEncryptionKey);
  }

  async signIn(input: AdminSignInRequest, now: Date = new Date()): Promise<AdminSessionGrant> {
    const admin = await this.admins.findLiveAdminByEmail(input.email);

    const usable =
      admin !== undefined &&
      admin.status === 'active' &&
      admin.passwordHash !== null &&
      admin.totpSecretEncrypted !== null;

    // Always one scrypt, whatever happened above.
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const passwordOk = await verifyPassword(
      input.password,
      usable ? (admin.passwordHash ?? '') : await this.dummyHash,
    );
    if (!usable) {
      throw this.fail(admin === undefined ? 'unknown_email' : 'account_not_usable');
    }
    if (!passwordOk) {
      throw this.fail('wrong_password');
    }

    let secret: Buffer;
    try {
      secret = this.box.open(admin.totpSecretEncrypted ?? '', totpSecretContext(admin.id));
    } catch (error: unknown) {
      if (error instanceof SecretBoxError) {
        // A key rotation, or a row copied from elsewhere. Loud in the log,
        // the same 401 to the caller.
        this.logger.error(`admin ${admin.id}: stored TOTP secret failed to open`);
        throw this.fail('totp_secret_unreadable');
      }
      throw error;
    }
    const step = matchTotpStep(secret, input.code, now, admin.lastTotpStep);
    // Claimed with a conditional UPDATE, so two concurrent sign-ins with one
    // code cannot both win: the second finds the step already taken.
    if (step === undefined || !(await this.admins.claimTotpStep(admin.id, step))) {
      throw this.fail('wrong_or_reused_code');
    }

    if (needsRehash(admin.passwordHash ?? '')) {
      await this.admins.updatePasswordHash(admin.id, await hashPassword(input.password));
    }

    const grant = await this.open(admin.id, now);
    await this.admins.appendAudit(
      {
        adminUserId: admin.id,
        action: 'admin.sign_in',
        targetType: 'admin_user',
        targetId: admin.id,
      },
      now,
    );
    return grant;
  }

  /**
   * Rotates a refresh token. A token already rotated more than a few seconds
   * ago means two parties hold the chain: the whole session is revoked.
   */
  async refresh(refreshToken: string, now: Date = new Date()): Promise<AdminRefreshOutcome> {
    const outcome = await this.admins.transaction(async (tx) => {
      const found = await this.admins.findRefreshTokenForUpdate(digestToken(refreshToken), tx);
      if (found === undefined) {
        throw this.fail('unknown_refresh_token');
      }
      const { token, session } = found;

      if (token.revokedAt !== null || session.revokedAt !== null) {
        throw this.fail('refresh_revoked');
      }
      if (token.rotatedAt !== null) {
        if (now.getTime() - token.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
          const me = await this.meFor(session.adminUserId);
          if (me === undefined) {
            throw this.fail('admin_not_active');
          }
          return { kind: 'concurrent' as const, me };
        }
        // Returned, not thrown: a throw here would roll the revocation back.
        await this.admins.revokeSessionAndTokens(session.id, now, tx);
        this.logger.warn(`admin session ${session.id}: refresh token reuse — session revoked`);
        return { kind: 'reuse' as const };
      }
      if (session.expiresAt.getTime() <= now.getTime()) {
        throw this.fail('session_expired');
      }
      if (now.getTime() - session.lastUsedAt.getTime() > this.config.idleTimeoutMs) {
        throw this.fail('session_idle_timeout');
      }

      const admin = await this.admins.findLiveAdminById(session.adminUserId);
      if (admin === undefined || admin.status !== 'active') {
        throw this.fail('admin_not_active');
      }

      await this.admins.markRefreshTokenRotated(token.id, now, tx);
      const next = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      await this.admins.insertRefreshToken(session.id, digestToken(next), now, tx);
      await this.admins.touchSession(session.id, now, tx);

      const roles = await this.admins.findRoles(admin.id);
      const access = this.tokens.issueAccessToken(
        { adminUserId: admin.id, sessionId: session.id },
        now,
      );
      return {
        kind: 'rotated' as const,
        grant: {
          me: {
            id: admin.id,
            email: admin.email,
            displayName: admin.displayName,
            roles,
            permissions: permissionsFor(roles),
          },
          accessToken: access.token,
          accessExpiresAt: access.expiresAt,
          refreshToken: next,
          sessionExpiresAt: session.expiresAt,
        },
      };
    });
    if (outcome.kind === 'reuse') {
      throw this.fail('refresh_reuse');
    }
    return outcome;
  }

  /** Ends the session a refresh token belongs to. Unknown tokens are ignored. */
  async signOut(refreshToken: string | undefined, now: Date = new Date()): Promise<void> {
    if (refreshToken === undefined) {
      return;
    }
    await this.admins.transaction(async (tx) => {
      const found = await this.admins.findRefreshTokenForUpdate(digestToken(refreshToken), tx);
      if (found !== undefined) {
        await this.admins.revokeSessionAndTokens(found.session.id, now, tx);
      }
    });
  }

  private async open(adminUserId: string, now: Date): Promise<AdminSessionGrant> {
    const admin = await this.admins.findLiveAdminById(adminUserId);
    if (admin === undefined) {
      throw this.fail('admin_vanished');
    }
    const roles = await this.admins.findRoles(adminUserId);
    const sessionExpiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    const session = await this.admins.transaction(async (tx) => {
      const created = await this.admins.createSession(adminUserId, sessionExpiresAt, tx);
      await this.admins.insertRefreshToken(created.id, digestToken(refreshToken), now, tx);
      return created;
    });
    const access = this.tokens.issueAccessToken({ adminUserId, sessionId: session.id }, now);

    return {
      me: {
        id: admin.id,
        email: admin.email,
        displayName: admin.displayName,
        roles,
        permissions: permissionsFor(roles),
      },
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      sessionExpiresAt,
    };
  }

  private async meFor(adminUserId: string): Promise<AdminMe | undefined> {
    const admin = await this.admins.findLiveAdminById(adminUserId);
    if (admin === undefined || admin.status !== 'active') {
      return undefined;
    }
    const roles = await this.admins.findRoles(adminUserId);
    return {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      roles,
      permissions: permissionsFor(roles),
    };
  }

  private fail(reason: string): AdminSignInFailedError {
    this.logger.warn(`admin sign-in refused: ${reason}`);
    return new AdminSignInFailedError(reason);
  }
}
