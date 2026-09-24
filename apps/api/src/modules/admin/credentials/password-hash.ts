import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Admin password hashing (ADR-0043 § 2): scrypt from `node:crypto`, stored as
 * one self-describing string so the cost can be raised later and every old
 * hash still verifies.
 *
 *     scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<key, base64url>
 *
 * N = 2^17, r = 8, p = 1 is OWASP's floor for scrypt. It costs about 128 MiB
 * and a few hundred milliseconds per hash, which is the point: a sign-in is a
 * handful a day per admin, an offline guess is billions.
 */
export interface ScryptParameters {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

export const CURRENT_SCRYPT_PARAMETERS: ScryptParameters = Object.freeze({ log2N: 17, r: 8, p: 1 });

/** NIST SP 800-63B § 3.1.1.2: a floor, a generous ceiling, no composition rules. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const PREFIX = 'scrypt';

/**
 * Bounds on a *stored* parameter set. The strings are ours, but a verifier
 * that would happily allocate whatever a row says is one bad migration away
 * from an out-of-memory crash on every sign-in.
 */
const MAX_LOG2_N = 20;
const MAX_R = 16;
const MAX_P = 4;

function scryptAsync(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  const N = 2 ** parameters.log2N;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      // `maxmem` must clear 128 * N * r bytes or Node refuses the call; the
      // default (32 MiB) is below what the current parameters need.
      { N, r: parameters.r, p: parameters.p, maxmem: 256 * N * parameters.r },
      (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(key);
      },
    );
  });
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = CURRENT_SCRYPT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, parameters);
  return [
    PREFIX,
    String(parameters.log2N),
    String(parameters.r),
    String(parameters.p),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return undefined;
  }
  const [, log2NText, rText, pText, saltText, keyText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const log2N = Number(log2NText);
  const r = Number(rText);
  const p = Number(pText);
  const inRange = (value: number, max: number): boolean =>
    Number.isInteger(value) && value >= 1 && value <= max;
  if (!inRange(log2N, MAX_LOG2_N) || !inRange(r, MAX_R) || !inRange(p, MAX_P)) {
    return undefined;
  }
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.length === 0 || key.length !== KEY_BYTES) {
    return undefined;
  }
  return { parameters: { log2N, r, p }, salt, key };
}

/**
 * Constant-time comparison of the derived key. A malformed stored value is a
 * `false`, never a throw: the caller answers every failure with the same 401.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === undefined) {
    return false;
  }
  const candidate = await scryptAsync(password, parsed.salt, parsed.parameters);
  return timingSafeEqual(candidate, parsed.key);
}

/** True when a hash was made with weaker parameters than today's. */
export function needsRehash(
  stored: string,
  current: ScryptParameters = CURRENT_SCRYPT_PARAMETERS,
): boolean {
  const parsed = parse(stored);
  if (parsed === undefined) {
    return true;
  }
  const { log2N, r, p } = parsed.parameters;
  return log2N < current.log2N || r < current.r || p < current.p;
}
