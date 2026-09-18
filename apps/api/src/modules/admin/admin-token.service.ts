import { Inject, Injectable } from '@nestjs/common';

import { JwtVerificationError, signHs256, verifyHs256 } from '../../common/crypto/hs256-jwt';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { AdminAuthConfig } from './admin.config';
import { ADMIN_CONFIG, ADMIN_TOKEN_AUDIENCE, ADMIN_TOKEN_ISSUER } from './admin.types';
import type { AdminAccessTokenClaims } from './admin.types';

/**
 * The single 401 the whole admin path answers with.
 *
 * One error, one response, whatever went wrong — a wrong signature, an expired
 * token, a revoked session, an idle timeout. The specific reason goes to the
 * server log and never to the caller: an admin endpoint that distinguishes
 * "no such admin" from "wrong token for a real admin" is an oracle for which
 * admin accounts exist, which is a list worth having if you are attacking one.
 */
export class InvalidAdminTokenError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    this.name = 'InvalidAdminTokenError';
    this.reason = reason;
    Object.setPrototypeOf(this, InvalidAdminTokenError.prototype);
  }
}

/**
 * Signs and verifies admin access tokens.
 *
 * A separate service from `TokenService` rather than a parameter on it,
 * because the only thing the two share is an algorithm. Different secret,
 * different audience, different claim shape, different lifetime policy — and
 * no refresh half at all, since nothing issues an admin login before EPIC 13
 * (ADR-0014). Merging them would put the one decision that must never be got
 * wrong — which family a token belongs to — behind a boolean argument.
 */
@Injectable()
export class AdminTokenService {
  constructor(@Inject(ADMIN_CONFIG) private readonly config: AdminAuthConfig) {}

  issueAccessToken(
    subject: { adminUserId: string; sessionId: string },
    now: Date = new Date(),
  ): { token: string; expiresAt: Date } {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = issuedAt + this.config.accessTtlSeconds;

    const claims: AdminAccessTokenClaims = {
      sub: subject.adminUserId,
      sid: subject.sessionId,
      iss: ADMIN_TOKEN_ISSUER,
      aud: ADMIN_TOKEN_AUDIENCE,
      iat: issuedAt,
      exp: expiresAtSeconds,
    };

    return {
      token: signHs256(claims, this.config.accessSecret),
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  /**
   * Verifies signature, expiry, issuer, audience and claim shape.
   *
   * The audience check is here rather than left to a caller, for the reason
   * `TokenService.verifyAccessToken` gives: the separation between the two
   * families is only structural if every verification path enforces it.
   */
  verifyAccessToken(token: string, now: Date = new Date()): AdminAccessTokenClaims {
    let record: Record<string, unknown>;
    try {
      record = verifyHs256(token, this.config.accessSecret, Math.floor(now.getTime() / 1000));
    } catch (error: unknown) {
      if (error instanceof JwtVerificationError) {
        throw new InvalidAdminTokenError(error.reason);
      }
      throw error;
    }

    const { sub, sid, iss, aud, iat, exp } = record;

    if (iss !== ADMIN_TOKEN_ISSUER || aud !== ADMIN_TOKEN_AUDIENCE) {
      throw new InvalidAdminTokenError('wrong_audience');
    }
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      throw new InvalidAdminTokenError('bad_claims');
    }
    if (typeof iat !== 'number' || typeof exp !== 'number') {
      throw new InvalidAdminTokenError('bad_claims');
    }

    return { sub, sid, iss: ADMIN_TOKEN_ISSUER, aud: ADMIN_TOKEN_AUDIENCE, iat, exp };
  }
}
