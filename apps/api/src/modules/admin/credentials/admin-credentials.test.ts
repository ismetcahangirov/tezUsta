import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword } from './password-hash';
import { SecretBox, SecretBoxError } from './secret-box';
import { base32Decode, base32Encode, hotp, matchTotpStep, otpauthUri, totpStepAt } from './totp';

/** Cheap parameters so the suite does not spend seconds per hash. */
const FAST = { log2N: 10, r: 8, p: 1 } as const;

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, the SHA-1 column: secret "12345678901234567890",
  // eight digits. Tested against the published vectors, not against itself.
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
  const vectors: readonly [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('matches the RFC vector at T=%i', (seconds, expected) => {
    expect(hotp(rfcSecret, totpStepAt(new Date(seconds * 1000)), 8)).toBe(expected);
  });

  it('round-trips base32 and matches the RFC 4648 test vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const secret = randomBytes(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('accepts the current step and one either side, and nothing further', () => {
    const secret = randomBytes(20);
    const now = new Date('2026-09-24T12:00:15Z');
    const step = totpStepAt(now);
    expect(matchTotpStep(secret, hotp(secret, step), now, null)).toBe(step);
    expect(matchTotpStep(secret, hotp(secret, step - 1), now, null)).toBe(step - 1);
    expect(matchTotpStep(secret, hotp(secret, step + 1), now, null)).toBe(step + 1);
    expect(matchTotpStep(secret, hotp(secret, step - 2), now, null)).toBeUndefined();
    expect(matchTotpStep(secret, hotp(secret, step + 2), now, null)).toBeUndefined();
  });

  it('never accepts a step at or before the last one used', () => {
    const secret = randomBytes(20);
    const now = new Date('2026-09-24T12:00:15Z');
    const step = totpStepAt(now);
    expect(matchTotpStep(secret, hotp(secret, step), now, step)).toBeUndefined();
    expect(matchTotpStep(secret, hotp(secret, step - 1), now, step - 1)).toBeUndefined();
    expect(matchTotpStep(secret, hotp(secret, step + 1), now, step)).toBe(step + 1);
  });

  it('refuses anything that is not six digits', () => {
    const secret = randomBytes(20);
    const now = new Date();
    for (const code of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(matchTotpStep(secret, code, now, null)).toBeUndefined();
    }
  });

  it('builds a Key Uri Format otpauth URI', () => {
    const uri = new URL(otpauthUri(Buffer.from('foobar'), 'aysel@tezusta.az'));
    expect(uri.protocol).toBe('otpauth:');
    // A non-special scheme: WHATWG URL reads `totp` as the host.
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/TezUsta:aysel@tezusta.az');
    expect(uri.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(uri.searchParams.get('issuer')).toBe('TezUsta');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});

describe('admin password hashing', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    expect(stored.startsWith('scrypt$10$8$1$')).toBe(true);
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', stored)).resolves.toBe(false);
  });

  it('salts every hash, so one password never hashes the same twice', async () => {
    const a = await hashPassword('same password here', FAST);
    const b = await hashPassword('same password here', FAST);
    expect(a).not.toBe(b);
  });

  it('treats the NFKC-equivalent spelling of a password as the same password', async () => {
    const stored = await hashPassword('ﬁle cabinet key', FAST);
    await expect(verifyPassword('file cabinet key', stored)).resolves.toBe(true);
  });

  it('answers false rather than throwing for a malformed or oversized stored value', async () => {
    for (const stored of ['', 'bcrypt$x', 'scrypt$99$8$1$AAAA$AAAA', 'scrypt$10$8$1$$']) {
      await expect(verifyPassword('anything at all', stored)).resolves.toBe(false);
    }
  });

  it('flags a hash made with weaker parameters for rehashing', async () => {
    expect(needsRehash(await hashPassword('another password', FAST))).toBe(true);
    expect(needsRehash(await hashPassword('another password', FAST), FAST)).toBe(false);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));

  it('opens what it sealed under the same context', () => {
    const secret = randomBytes(20);
    expect(box.open(box.seal(secret, 'admin:1'), 'admin:1').equals(secret)).toBe(true);
  });

  it('refuses a sealed value moved to another context', () => {
    const sealed = box.seal(randomBytes(20), 'admin:1');
    expect(() => box.open(sealed, 'admin:2')).toThrow(SecretBoxError);
  });

  it('refuses a tampered or truncated value', () => {
    const sealed = box.seal(randomBytes(20), 'admin:1');
    const parts = sealed.split('.');
    const ciphertext = Buffer.from(parts[2] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    const flipped = [parts[0], parts[1], ciphertext.toString('base64url'), parts[3]].join('.');
    expect(() => box.open(flipped, 'admin:1')).toThrow(SecretBoxError);
    const shortTag = [parts[0], parts[1], parts[2], (parts[3] ?? '').slice(0, 6)].join('.');
    expect(() => box.open(shortTag, 'admin:1')).toThrow(SecretBoxError);
  });

  it('refuses a value sealed under a different key', () => {
    const other = new SecretBox(randomBytes(32));
    expect(() => box.open(other.seal(randomBytes(20), 'admin:1'), 'admin:1')).toThrow(
      SecretBoxError,
    );
  });
});
