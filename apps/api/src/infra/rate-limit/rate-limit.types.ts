/**
 * The two axes every authentication limit is enforced on, independently:
 * the thing being authenticated (a phone number, an admin email, a session
 * id) and where the request came from.
 *
 * Both exist because each alone is trivially defeated. A per-identifier limit
 * only is bypassed by rotating phone numbers from one host — which is exactly
 * the SMS-cost attack ADR-0008 calls "the realistic attack here". A per-IP
 * limit only is bypassed by a botnet or a mobile carrier NAT, and it is also
 * the one that punishes innocents, because a whole carrier can share an
 * address. Neither is a substitute for the other, so exceeding **either**
 * denies (`docs/architecture/authentication.md` § Rate limiting).
 */
export type RateLimitDimension = 'identifier' | 'ip';

/**
 * One limit to evaluate. The numbers are parameters rather than something
 * this layer looks up, so the service stays a primitive with no opinion about
 * policy: the guard is what translates a policy name into these, and
 * `rate-limit.config.ts` is what gets the numbers from validated
 * configuration (CLAUDE.md §20 — never a literal).
 */
export interface RateLimitRequest {
  /**
   * The policy this counter belongs to, e.g. `otp-request`. Part of the Redis
   * key, so two policies never share a counter, and it is deliberately the
   * one part of the key that is human-readable — an operator has to be able to
   * tell which limit a key belongs to without being able to tell *whose* it
   * is.
   */
  readonly scope: string;
  readonly dimension: RateLimitDimension;
  /**
   * The raw value being limited — a phone number, an IP, a session id. It is
   * hashed before it reaches Redis and is never returned, logged, or stored.
   */
  readonly subject: string;
  /** Requests permitted per window. The (limit + 1)-th is denied. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Ceiling on how far backoff may push the window's reset out. Every request
   * made while already over the limit extends the window by `windowMs`, up to
   * this value — "with backoff", per ADR-0008 § Security requirements.
   * Set it equal to `windowMs` to disable backoff.
   */
  readonly backoffCeilingMs: number;
}

/**
 * Everything a caller needs to answer a 429 properly, without a second round
 * trip to Redis: whether to proceed, what is left, and when it frees up.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly dimension: RateLimitDimension;
  readonly limit: number;
  /** Never negative: once over the limit this is 0, not a running deficit. */
  readonly remaining: number;
  readonly resetAt: Date;
  /**
   * Whole seconds until `resetAt`, floored at 1 — the value that goes in the
   * `Retry-After` header and in the error envelope's `details`. Never 0: a
   * `Retry-After: 0` invites an immediate retry, which is the opposite of
   * what a rate limiter is asking for.
   */
  readonly retryAfterSeconds: number;
  /**
   * A short, non-reversible, pepper-keyed digest of the subject. This is the
   * ONLY representation of the subject that may appear in a log line —
   * `docs/engineering/security.md` § Logging forbids the full phone number,
   * and a security event that identifies nobody is not much of an audit
   * trail. Two events with the same digest are the same subject under the
   * same policy; nothing else can be recovered from it.
   */
  readonly subjectDigest: string;
}

/**
 * One tick of an attempt cap — "max 5 attempts per code, then invalidate"
 * (ADR-0008). Distinct from a rate limit and deliberately so:
 *
 * - a rate limit is a *rolling* budget on a phone number or an IP, and it
 *   backs off; an attempt cap is a *fixed* budget on one short-lived secret,
 *   and it must expire exactly when that secret does,
 * - a rate limit denies; an attempt cap tells its owner that the secret is
 *   now spent, and the owner decides what to destroy.
 *
 * Issue #29 owns that decision. This primitive counts and reports; it never
 * touches an OTP record.
 */
export interface AttemptRequest {
  /** e.g. `otp-verify`. Part of the key, same role as `RateLimitRequest.scope`. */
  readonly scope: string;
  /**
   * Identifies the *secret*, not the person — for OTP that is the challenge
   * id, so issuing a new code starts a new cap and an attacker cannot carry
   * a burnt budget over, nor spend one code's budget to lock out the next.
   */
  readonly subject: string;
  readonly maxAttempts: number;
  /**
   * Must be the secret's own remaining lifetime. A counter that outlives the
   * code it guards locks out the next code; one that dies first silently
   * resets the cap mid-attack.
   */
  readonly ttlMs: number;
}

export interface AttemptTally {
  /** Attempts consumed so far, including this one. */
  readonly used: number;
  readonly remaining: number;
  /** True once `used` has reached `maxAttempts`. */
  readonly exhausted: boolean;
  readonly expiresAt: Date;
  /** Safe-to-log digest — see {@link RateLimitDecision.subjectDigest}. */
  readonly subjectDigest: string;
}
