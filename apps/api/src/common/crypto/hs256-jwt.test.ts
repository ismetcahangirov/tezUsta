import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { JwtFailureReason } from './hs256-jwt';
import { JwtVerificationError, signHs256, verifyHs256 } from './hs256-jwt';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

function futureExp(secondsFromNow = 3600): number {
  return Math.floor(Date.now() / 1000) + secondsFromNow;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Every failure case below is asserted through this one helper rather than
 * `.toThrow(JwtVerificationError)` alone, because the whole point of
 * {@link JwtVerificationError} carrying a `reason` is that a caller — and this
 * test — can tell "expired" apart from "bad signature" apart from
 * "unsupported_header". A bare `.toThrow` would pass just as happily if every
 * one of these cases collapsed into the same reason.
 */
function expectJwtFailure(run: () => unknown, reason: JwtFailureReason): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(JwtVerificationError);
  expect((caught as JwtVerificationError).reason).toBe(reason);
}

/** Flips the last character of `value` to something guaranteed different. */
function flipOneChar(value: string): string {
  const lastChar = value.at(-1);
  const replacement = lastChar === 'a' ? 'b' : 'a';
  return `${value.slice(0, -1)}${replacement}`;
}

describe('signHs256 / verifyHs256 round-trip', () => {
  it('returns the exact claims that were signed', () => {
    const claims = { sub: 'user-1', role: 'customer', exp: futureExp() };
    const token = signHs256(claims, SECRET);

    expect(verifyHs256(token, SECRET)).toEqual(claims);
  });
});

describe('signature verification', () => {
  it('rejects a token signed with a different secret', () => {
    const token = signHs256({ exp: futureExp() }, SECRET);

    expectJwtFailure(() => verifyHs256(token, OTHER_SECRET), 'bad_signature');
  });

  it('rejects a token with one character of the payload flipped', () => {
    const token = signHs256({ sub: 'user-1', exp: futureExp() }, SECRET);
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${flipOneChar(payload as string)}.${signature}`;

    expectJwtFailure(() => verifyHs256(tampered, SECRET), 'bad_signature');
  });

  it('rejects a token with one character of the signature flipped', () => {
    const token = signHs256({ sub: 'user-1', exp: futureExp() }, SECRET);
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${flipOneChar(signature as string)}`;

    expectJwtFailure(() => verifyHs256(tampered, SECRET), 'bad_signature');
  });
});

describe('expiry', () => {
  it('rejects a token whose exp is already in the past', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const token = signHs256({ exp: pastExp }, SECRET);

    expectJwtFailure(() => verifyHs256(token, SECRET), 'expired');
  });

  it('rejects a token at the exact boundary — the check is now >= exp', () => {
    const exp = 1_000_000;
    const token = signHs256({ exp }, SECRET);

    expectJwtFailure(() => verifyHs256(token, SECRET, exp), 'expired');
  });

  it('accepts a token one second before its exp', () => {
    const exp = 1_000_000;
    const token = signHs256({ exp }, SECRET);

    expect(verifyHs256(token, SECRET, exp - 1)).toEqual({ exp });
  });

  it('rejects a token with no exp claim at all', () => {
    const token = signHs256({ sub: 'user-1' }, SECRET);

    expectJwtFailure(() => verifyHs256(token, SECRET), 'bad_payload');
  });
});

describe('algorithm confusion', () => {
  it('rejects a token whose header claims alg:none with an empty signature', () => {
    const header = base64urlJson({ alg: 'none', typ: 'JWT' });
    const payload = base64urlJson({ exp: futureExp() });
    const token = `${header}.${payload}.`;

    expectJwtFailure(() => verifyHs256(token, SECRET), 'unsupported_header');
  });

  it('rejects a token whose header claims HS512 even when correctly HMAC-signed', () => {
    // Built by hand rather than via `signHs256` (which only ever emits the
    // fixed HS256 header) — this reproduces exactly what an attacker who
    // controls the header, but not the secret, could send: a genuine
    // HMAC-SHA256 signature computed over a signing input whose header just
    // says something else. The file comment on hs256-jwt.ts promises this is
    // unrepresentable by construction; this is the test of that promise.
    const header = base64urlJson({ alg: 'HS512', typ: 'JWT' });
    const payload = base64urlJson({ exp: futureExp() });
    const signingInput = `${header}.${payload}`;
    const signature = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
    const token = `${signingInput}.${signature}`;

    expectJwtFailure(() => verifyHs256(token, SECRET), 'unsupported_header');
  });
});

describe('malformed input', () => {
  it.each([
    ['empty string', ''],
    ['one segment', 'onlyoneseg'],
    ['four segments', 'a.b.c.d'],
  ])('rejects %s as malformed, and only as JwtVerificationError', (_label, token) => {
    expectJwtFailure(() => verifyHs256(token, SECRET), 'malformed');
  });

  it('rejects a token whose payload is not valid base64url JSON', () => {
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const notJson = Buffer.from('not-json-at-all', 'utf8').toString('base64url');
    const signingInput = `${header}.${notJson}`;
    const signature = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
    const token = `${signingInput}.${signature}`;

    expectJwtFailure(() => verifyHs256(token, SECRET), 'bad_payload');
  });

  it('rejects a token whose payload is a JSON array rather than an object', () => {
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const arrayPayload = base64urlJson([1, 2, 3]);
    const signingInput = `${header}.${arrayPayload}`;
    const signature = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
    const token = `${signingInput}.${signature}`;

    expectJwtFailure(() => verifyHs256(token, SECRET), 'bad_payload');
  });
});
