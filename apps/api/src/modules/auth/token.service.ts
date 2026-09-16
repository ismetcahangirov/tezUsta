import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { JwtVerificationError, signHs256, verifyHs256 } from '../../common/crypto/hs256-jwt';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { UserRoleName } from '../../infra/database/schema/users';
import type { AuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import type { AccessTokenClaims, AccessTokenSubject } from './auth.types';
import { CONSUMER_TOKEN_AUDIENCE, CONSUMER_TOKEN_ISSUER } from './auth.types';

/**
 * The single 401 the whole authentication path answers with.
 *
 * One message and one code for every cause — expired, tampered, wrong
 * audience, unknown session. `docs/architecture/authentication.md` and issue
 * #27 both require that a guard not leak which check failed; a client that can
 * tell "expired" from "bad signature" holds an oracle it was never meant to
 * have. The specific reason is logged server-side, correlated by requestId.
 */
export class InvalidAccessTokenError extends AppError {
  constructor() {
    super(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    this.name = 'InvalidAccessTokenError';
    Object.setPrototypeOf(this, InvalidAccessTokenError.prototype);
  }
}

/** Bytes of CSPRNG material in the secret half of a refresh token. */
const REFRESH_SECRET_BYTES = 32;

/** A freshly minted refresh token, before it is written to the database. */
export interface MintedRefreshToken {
  /** The row id, and the public half of the string handed to the client. */
  readonly id: string;
  /** `<id>.<secret>` — the only moment the plaintext exists. Never stored. */
  readonly token: string;
  /** What `refresh_tokens.token_hash` receives. */
  readonly tokenHash: string;
}

function isRoleArray(value: unknown): value is UserRoleName[] {
  return Array.isArray(value) && value.every((entry) => entry === 'customer' || entry === 'master');
}

/**
 * Mints and verifies the two token families
 * (`docs/architecture/authentication.md` § Token model).
 *
 * It owns no state and touches no database: it turns a subject into strings
 * and a string back into claims. Which sessions exist, and which are revoked,
 * belongs to the sessions layer, because that is stateful and this is not.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /**
   * Signs a 15-minute access token (`config.accessTtlSeconds`).
   *
   * Short by design: an access token is self-contained, so the server does not
   * consult the database to validate it and therefore cannot revoke it before
   * expiry. Fifteen minutes bounds the damage from a stolen one; real
   * revocation lives at the refresh layer, which is stateful.
   */
  issueAccessToken(
    subject: AccessTokenSubject,
    now: Date = new Date(),
  ): { token: string; expiresAt: Date } {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = issuedAt + this.config.accessTtlSeconds;

    const claims: AccessTokenClaims = {
      sub: subject.userId,
      sid: subject.sessionId,
      roles: subject.roles,
      iss: CONSUMER_TOKEN_ISSUER,
      aud: CONSUMER_TOKEN_AUDIENCE,
      iat: issuedAt,
      exp: expiresAtSeconds,
    };

    return {
      token: signHs256(claims, this.config.accessSecret),
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  /**
   * Verifies signature, expiry, issuer, audience and claim shape, and returns
   * the claims. Throws {@link InvalidAccessTokenError} for every failure.
   *
   * The returned `roles` are still only a **claim**. The caller re-reads
   * current status and roles from the database before making any authorization
   * decision (issue #27) — this method proves the token is ours and current,
   * and nothing more.
   */
  verifyAccessToken(token: string, now: Date = new Date()): AccessTokenClaims {
    let record: Record<string, unknown>;
    try {
      record = verifyHs256(token, this.config.accessSecret, Math.floor(now.getTime() / 1000));
    } catch (error: unknown) {
      if (error instanceof JwtVerificationError) {
        throw new InvalidAccessTokenError();
      }
      throw error;
    }

    const { sub, sid, roles, iss, aud, iat, exp } = record;

    // `iss`/`aud` are checked here, not left to a caller to remember. The
    // consumer and admin token families deliberately share neither
    // (ADR-0014), and that separation is only structural if every verification
    // path enforces it.
    if (iss !== CONSUMER_TOKEN_ISSUER || aud !== CONSUMER_TOKEN_AUDIENCE) {
      throw new InvalidAccessTokenError();
    }
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      throw new InvalidAccessTokenError();
    }
    if (typeof iat !== 'number' || typeof exp !== 'number') {
      throw new InvalidAccessTokenError();
    }
    if (!isRoleArray(roles)) {
      throw new InvalidAccessTokenError();
    }

    return {
      sub,
      sid,
      roles: Object.freeze([...roles]),
      iss: CONSUMER_TOKEN_ISSUER,
      aud: CONSUMER_TOKEN_AUDIENCE,
      iat,
      exp,
    };
  }

  /**
   * Mints a refresh token: a UUIDv7 row id joined to 32 CSPRNG bytes.
   *
   * Not a JWT. A refresh token is checked against the database on every use
   * anyway — that is the entire point of the stateful layer — so a
   * self-contained token would add claims to steal and buy nothing. Carrying
   * the row id in the clear is what lets verification be one indexed lookup
   * instead of a scan that re-hashes every candidate row.
   */
  mintRefreshToken(): MintedRefreshToken {
    const id = uuidV7();
    const secret = randomBytes(REFRESH_SECRET_BYTES).toString('base64url');

    return {
      id,
      token: `${id}.${secret}`,
      tokenHash: this.hashRefreshSecret(secret),
    };
  }

  /**
   * Splits `<id>.<secret>`. Returns `null` for anything that is not that
   * shape, so a malformed string never reaches a database lookup.
   */
  parseRefreshToken(token: string): { id: string; secret: string } | null {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [id, secret] = parts;
    if (id === undefined || secret === undefined || id.length === 0 || secret.length === 0) {
      return null;
    }
    return { id, secret };
  }

  /**
   * HMAC-SHA256 of the secret half, **keyed by `JWT_REFRESH_SECRET`** — a
   * pepper the database never holds.
   *
   * NIST SP 800-63B §5.1.2.2 would be satisfied by a plain SHA-256 here: the
   * secret carries 256 bits of entropy, far above the 112-bit line at which a
   * slow, salted KDF becomes mandatory, and no KDF makes an unguessable value
   * more unguessable. The pepper is free defence in depth on top of that — a
   * leaked dump cannot be attacked at all without also stealing the
   * application secret — and it is what makes `JWT_REFRESH_SECRET` genuinely a
   * *separate* secret (issue #25) rather than a variable nothing reads.
   *
   * Rotating `JWT_REFRESH_SECRET` therefore invalidates every outstanding
   * refresh token, signing every user out. That is the correct behaviour for a
   * compromised key, and must not be "fixed" by keeping an old pepper alive.
   */
  hashRefreshSecret(secret: string): string {
    return createHmac('sha256', this.config.refreshSecret).update(secret).digest('hex');
  }

  /**
   * Constant-time comparison of a presented secret against a stored hash.
   * Both operands are fixed-length hex digests, so a length mismatch means the
   * stored value is not one of ours — which is not information about the
   * secret.
   */
  refreshSecretMatches(secret: string, storedHash: string): boolean {
    const computed = this.hashRefreshSecret(secret);
    if (computed.length !== storedHash.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(storedHash, 'utf8'));
  }
}
