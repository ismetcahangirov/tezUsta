import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signHs256 } from '../../common/crypto/hs256-jwt';
import { AppError } from '../../common/errors/app-error';
import type { AuthConfig } from './auth.config';
import type { AccessTokenSubject } from './auth.types';
import { CONSUMER_TOKEN_AUDIENCE, CONSUMER_TOKEN_ISSUER } from './auth.types';
import { InvalidAccessTokenError, TokenService } from './token.service';

const authConfig: AuthConfig = {
  accessSecret: 'a'.repeat(32),
  refreshSecret: 'b'.repeat(32),
  accessTtlSeconds: 900,
  refreshTtlMs: 2_592_000_000,
  refreshReuseGraceMs: 10_000,
};

const SUBJECT: AccessTokenSubject = {
  userId: 'user-1',
  sessionId: 'session-1',
  roles: ['customer', 'master'],
};

function flipOneChar(value: string): string {
  const lastChar = value.at(-1);
  const replacement = lastChar === 'a' ? 'b' : 'a';
  return `${value.slice(0, -1)}${replacement}`;
}

describe('TokenService — access tokens', () => {
  it('issues a token that verifies and carries sub, sid, roles, iss, aud', () => {
    const service = new TokenService(authConfig);

    const { token } = service.issueAccessToken(SUBJECT);
    const claims = service.verifyAccessToken(token);

    expect(claims.sub).toBe(SUBJECT.userId);
    expect(claims.sid).toBe(SUBJECT.sessionId);
    expect(claims.roles).toEqual(SUBJECT.roles);
    expect(claims.iss).toBe(CONSUMER_TOKEN_ISSUER);
    expect(claims.aud).toBe(CONSUMER_TOKEN_AUDIENCE);
  });

  it('rejects an expired, a tampered, and a wrong-audience token with the same 401 AppError — the guard must not leak which check failed', () => {
    const service = new TokenService(authConfig);

    // Expired: minted far enough in the past that its TTL has already
    // elapsed by the time verification runs with the real clock.
    const expiredIssuedAt = new Date(Date.now() - (authConfig.accessTtlSeconds + 60) * 1000);
    const { token: expiredToken } = service.issueAccessToken(SUBJECT, expiredIssuedAt);

    // Tampered: a validly-issued token with one payload character flipped.
    const { token: goodToken } = service.issueAccessToken(SUBJECT);
    const [header, payload, signature] = goodToken.split('.');
    const tamperedToken = `${header}.${flipOneChar(payload as string)}.${signature}`;

    // Wrong audience: signed by hand with the real secret (so the signature
    // itself is valid) but an audience that is not the consumer app's.
    const wrongAudienceToken = signHs256(
      {
        sub: SUBJECT.userId,
        sid: SUBJECT.sessionId,
        roles: SUBJECT.roles,
        iss: CONSUMER_TOKEN_ISSUER,
        aud: 'some-other-audience',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      authConfig.accessSecret,
    );

    const failures = [expiredToken, tamperedToken, wrongAudienceToken].map((token) => {
      try {
        service.verifyAccessToken(token);
        throw new Error('expected verifyAccessToken to throw');
      } catch (error) {
        return error;
      }
    });

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('UNAUTHORIZED');
      expect((failure as AppError).status).toBe(401);
    }

    const messages = failures.map((failure) => (failure as AppError).message);
    expect(new Set(messages).size).toBe(1);
  });

  it('rejects a token minted with a different issuer', () => {
    const service = new TokenService(authConfig);

    const token = signHs256(
      {
        sub: SUBJECT.userId,
        sid: SUBJECT.sessionId,
        roles: SUBJECT.roles,
        iss: 'some-other-issuer',
        aud: CONSUMER_TOKEN_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      authConfig.accessSecret,
    );

    expect(() => service.verifyAccessToken(token)).toThrow(AppError);
  });

  it('rejects a token whose roles claim contains an unknown role string', () => {
    const service = new TokenService(authConfig);

    const token = signHs256(
      {
        sub: SUBJECT.userId,
        sid: SUBJECT.sessionId,
        roles: ['admin'], // not 'customer' or 'master'
        iss: CONSUMER_TOKEN_ISSUER,
        aud: CONSUMER_TOKEN_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      authConfig.accessSecret,
    );

    expect(() => service.verifyAccessToken(token)).toThrow(AppError);
  });

  it('carries the failure reason as a plain property, and never on `details` where the response envelope would expose it', () => {
    const service = new TokenService(authConfig);

    // Any of the rejection paths would do; expiry is the simplest to produce
    // deterministically.
    const expiredIssuedAt = new Date(Date.now() - (authConfig.accessTtlSeconds + 60) * 1000);
    const { token } = service.issueAccessToken(SUBJECT, expiredIssuedAt);

    let caught: unknown;
    try {
      service.verifyAccessToken(token);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidAccessTokenError);
    expect((caught as InvalidAccessTokenError).reason).toBe('expired');
    // `AppError.details` is what the global exception filter copies into the
    // client-facing envelope. If the reason ever migrated there instead of
    // staying a plain property, a client would gain exactly the "expired vs
    // bad signature" oracle issue #27 forbids.
    expect((caught as AppError).details).toBeUndefined();
  });
});

describe('TokenService — refresh tokens', () => {
  it('mints a token shaped <id>.<secret>, where id is a uuid and the stored hash is an independently-computed HMAC of the secret, keyed by JWT_REFRESH_SECRET', () => {
    const service = new TokenService(authConfig);

    const minted = service.mintRefreshToken();
    const [id, secret] = minted.token.split('.');

    expect(id).toBe(minted.id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(secret).toBeDefined();

    // A "does not contain" check on a 64-character hex digest against an
    // 80-character token string passes for the wrong reason — a shorter
    // string can never be a substring of a longer one, regardless of the
    // hashing logic. Asserting equality with an independently computed HMAC
    // is the only way this test would fail if `hashRefreshSecret` regressed
    // to, say, hashing the whole token instead of just the secret half, or
    // dropped the pepper.
    const expectedHash = createHmac('sha256', authConfig.refreshSecret)
      .update(secret as string)
      .digest('hex');
    expect(minted.tokenHash).toBe(expectedHash);
  });

  it.each([
    ['no dot', 'nosecretnodot'],
    ['a leading dot', '.onlysecret'],
    ['a trailing dot', 'idonly.'],
    ['two dots', 'a.b.c'],
  ])('returns null for a malformed refresh token (%s)', (_label, malformed) => {
    const service = new TokenService(authConfig);

    expect(service.parseRefreshToken(malformed)).toBeNull();
  });

  describe('parseRefreshToken validates both halves, not just "exactly one dot" (regression: "abc.def" used to reach a uuid column and raise Postgres 22P02 — a 500 where a 401 is owed)', () => {
    it('returns null for "abc.def" — neither half is well-shaped', () => {
      const service = new TokenService(authConfig);

      expect(service.parseRefreshToken('abc.def')).toBeNull();
    });

    it('returns null for a real uuid id paired with a too-short secret', () => {
      const service = new TokenService(authConfig);
      const minted = service.mintRefreshToken();

      expect(service.parseRefreshToken(`${minted.id}.tooshort`)).toBeNull();
    });

    it('returns null for a well-shaped secret paired with a non-uuid id', () => {
      const service = new TokenService(authConfig);
      const minted = service.mintRefreshToken();
      const secret = minted.token.split('.')[1] as string;

      expect(service.parseRefreshToken(`not-a-real-uuid.${secret}`)).toBeNull();
    });
  });

  it('parses a well-formed <id>.<secret> token into its two halves', () => {
    const service = new TokenService(authConfig);
    const minted = service.mintRefreshToken();

    expect(service.parseRefreshToken(minted.token)).toEqual({
      id: minted.id,
      secret: minted.token.split('.')[1],
    });
  });

  it('matches the minted secret against its own hash, and rejects a near-miss', () => {
    const service = new TokenService(authConfig);
    const minted = service.mintRefreshToken();
    const secret = minted.token.split('.')[1] as string;

    expect(service.refreshSecretMatches(secret, minted.tokenHash)).toBe(true);
    expect(service.refreshSecretMatches(flipOneChar(secret), minted.tokenHash)).toBe(false);
  });

  it('never mints the same refresh token twice', () => {
    const service = new TokenService(authConfig);

    const first = service.mintRefreshToken();
    const second = service.mintRefreshToken();

    expect(first.id).not.toBe(second.id);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});
