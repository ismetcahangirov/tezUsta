import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A minimal, deliberately single-algorithm JWT (RFC 7519) implementation:
 * HS256 and nothing else.
 *
 * **Why this is not a library** (CLAUDE.md §10, and the dependency review
 * recorded in `docs/engineering/dependency-policy.md`):
 *
 * - `@nestjs/jwt@12.0.2` peers cleanly against `@nestjs/common@12`, but it
 *   wraps `jsonwebtoken@9.0.3`, which pulls nine further packages (`jws`,
 *   `ms`, `semver`, six `lodash.*` micro-packages) to support an algorithm
 *   matrix this project will never use.
 * - `jose@6.2.12` is a genuinely good, zero-dependency alternative and was
 *   verified to work under this repository's exact CommonJS/NodeNext build via
 *   Node 24's `require(esm)`. It is the right escalation the day TezUsta needs
 *   asymmetric signing or a JWKS — neither is in scope here.
 *
 * **The alg-confusion class of bug is closed by construction, not by
 * configuration.** This file never reads `alg` from the header to *choose* a
 * verification strategy; it compares the received header against one constant
 * string. `alg: none` and an RS256-token-verified-as-HMAC are therefore not
 * "defaults we remembered to override" but shapes this code cannot express.
 *
 * Nest-free and Fastify-free on purpose: it is a primitive, so it moves to a
 * shared package as a file move if a second consumer ever appears (ADR-0016).
 */

/**
 * `{"alg":"HS256","typ":"JWT"}`, base64url-encoded once at module load. Both
 * signing and verification use this exact string — verification compares
 * against it rather than parsing the inbound header, which is what makes an
 * attacker-chosen algorithm unrepresentable.
 */
const ENCODED_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
  'base64url',
);

export type JwtFailureReason =
  'malformed' | 'unsupported_header' | 'bad_signature' | 'bad_payload' | 'expired';

/**
 * Carries a machine-readable `reason` for the server log only. The caller must
 * answer every one of them with the same generic 401: telling a client
 * "expired" rather than "bad signature" hands an attacker a free oracle, and
 * issue #27 requires that guards do not leak which check failed.
 */
export class JwtVerificationError extends Error {
  readonly reason: JwtFailureReason;

  constructor(reason: JwtFailureReason) {
    super(`JWT verification failed: ${reason}`);
    this.name = 'JwtVerificationError';
    this.reason = reason;
    Object.setPrototypeOf(this, JwtVerificationError.prototype);
  }
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Constant-time comparison of the two base64url signature **strings**, not of
 * their decoded bytes.
 *
 * `Buffer.from(value, 'base64url')` is lenient — it ignores characters outside
 * the alphabet and tolerates length quirks — so two different received strings
 * can decode to the same bytes. Comparing the encoded forms removes that
 * malleability entirely: there is exactly one string this function accepts.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked
 * first. That check is not itself constant-time, and does not need to be: a
 * wrong signature *length* reveals nothing about the correct signature, only
 * that the token is not one we issued.
 */
function signatureMatches(expected: string, received: string): boolean {
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

/**
 * Signs `claims` and returns the compact serialization. `claims` must already
 * contain every registered claim the caller intends (`exp`, `iat`, `iss`,
 * `aud`, …) — this function adds nothing implicitly, so what is in the token
 * is exactly what the caller decided to put there.
 *
 * Typed `object` rather than `Record<string, unknown>` so a caller can pass a
 * precise interface (`AccessTokenClaims`) without widening it first; an
 * interface has no index signature, and widening at the call site is exactly
 * the step that stops the compiler checking the claim names.
 */
export function signHs256(claims: object, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${ENCODED_HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * Verifies signature, header, and expiry, and returns the decoded claims.
 * Throws {@link JwtVerificationError} for every failure — never returns a
 * partially-trusted result.
 *
 * `nowSeconds` is injectable so a test can assert the expiry boundary without
 * sleeping; production always passes the default.
 */
export function verifyHs256(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtVerificationError('malformed');
  }

  const [header, payload, signature] = parts;
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new JwtVerificationError('malformed');
  }

  // The header is compared, never parsed. See the file comment.
  if (header !== ENCODED_HEADER) {
    throw new JwtVerificationError('unsupported_header');
  }

  if (!signatureMatches(sign(`${header}.${payload}`, secret), signature)) {
    throw new JwtVerificationError('bad_signature');
  }

  // Only past this point is the payload trusted enough to parse: a signature
  // check on attacker-controlled bytes must happen before JSON.parse sees them.
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new JwtVerificationError('bad_payload');
  }

  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new JwtVerificationError('bad_payload');
  }

  const record = claims as Record<string, unknown>;
  const { exp } = record;
  if (typeof exp !== 'number') {
    // A token with no expiry is a permanent credential. Reject rather than
    // treat "absent" as "never expires".
    throw new JwtVerificationError('bad_payload');
  }
  // `exp` is the first instant at which the token is no longer valid
  // (RFC 7519 §4.1.4). No clock tolerance: both signer and verifier are this
  // one service, so there is no skew to absorb, and a tolerance would only
  // widen the window a stolen token stays usable.
  if (nowSeconds >= exp) {
    throw new JwtVerificationError('expired');
  }

  return record;
}
