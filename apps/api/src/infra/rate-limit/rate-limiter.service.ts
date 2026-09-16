import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.tokens';
import type { RateLimitConfig } from './rate-limit.config';
import { RATE_LIMIT_CONFIG } from './rate-limit.tokens';
import type {
  AttemptRequest,
  AttemptTally,
  RateLimitDecision,
  RateLimitDimension,
  RateLimitRequest,
} from './rate-limit.types';

/**
 * Key prefix, versioned. A change to the key layout or to the digest must
 * bump `v1`, because the old keys keep their TTL and would otherwise be read
 * as if they meant something under the new scheme — a caller mid-window would
 * silently get a fresh budget, or an old one that never clears.
 */
const KEY_PREFIX = 'rl:v1';

/**
 * 128 bits of the HMAC output, hex-encoded. Long enough that a collision
 * between two subjects — which would merge two people's budgets — is not a
 * thing that happens, and short enough to keep the key readable in
 * `redis-cli`.
 */
const DIGEST_HEX_LENGTH = 32;

/** How much of the digest is safe and useful to put in a log line. */
const LOG_DIGEST_HEX_LENGTH = 12;

/**
 * Increment-and-expire, committed together.
 *
 * The naive version of this is two round trips — `INCR key` then
 * `PEXPIRE key window` — and it has a failure that is not theoretical: if the
 * API process dies, is evicted, or simply loses its connection in the gap
 * between them, the key survives with **no expiry at all**. `PTTL` then
 * returns -1 forever, the counter only ever climbs, and the phone number or
 * IP that happened to be mid-request is rate-limited permanently, with no
 * error anywhere and nothing to make it recover. The only cure is a human
 * finding and deleting a key whose name is a hash. On the OTP path that is a
 * user who can never sign in again.
 *
 * Redis runs a script as one unit, so INCR and PEXPIRE either both apply or
 * neither does, and that hole cannot open. The `ttl < 0` branch below is
 * belt-and-braces for a key left behind by an older, two-call implementation:
 * it repairs it rather than inheriting it.
 *
 * The script also implements the backoff ADR-0008 asks for: a request made
 * while ALREADY over the limit pushes the window's reset further out, up to a
 * ceiling. Backoff is applied only to requests that are refused, so an honest
 * caller who stops when told to never sees it, and a caller who keeps
 * hammering waits longer each time — which is what makes hammering a losing
 * strategy rather than a free retry.
 *
 * KEYS[1] counter key
 * ARGV[1] limit          ARGV[2] window ms          ARGV[3] backoff ceiling ms
 * returns { count, ttlMs, allowed }   (1/0 — Lua `false` would truncate the reply)
 */
const CONSUME_SCRIPT = `
local limit      = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])
local ceilingMs  = tonumber(ARGV[3])

local count = redis.call('INCR', KEYS[1])
local ttl   = redis.call('PTTL', KEYS[1])

-- PTTL answers -1 for a key with no expiry and -2 for a missing key. INCR
-- just created or touched this one, so -1 is the only reachable negative, and
-- it means an earlier non-atomic writer left the key immortal. Give it the
-- window it should have had.
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
  ttl = windowMs
end

if count > limit then
  -- The ceilingMs > windowMs test is what makes a multiplier of 1 mean "plain
  -- fixed window" rather than "window restarts on every refusal". Without
  -- it, clamping to the ceiling would still push a partly-elapsed window back
  -- out to its full length, which is a rolling block wearing backoff's name.
  if ceilingMs > windowMs then
    local extended = ttl + windowMs
    if extended > ceilingMs then
      extended = ceilingMs
    end
    if extended > ttl then
      redis.call('PEXPIRE', KEYS[1], extended)
      ttl = extended
    end
  end
  return { count, ttl, 0 }
end

return { count, ttl, 1 }
`;

/**
 * Attempt cap: the same atomicity guarantee, without the backoff.
 *
 * The TTL is set once, on the first attempt, and is never extended. That is
 * the difference that matters: this counter guards ONE short-lived secret and
 * must die with it. Extending it would outlive the OTP code and cap the next
 * code the user asks for — turning five wrong guesses into a lockout the user
 * cannot clear by requesting a new code.
 *
 * KEYS[1] attempt key      ARGV[1] ttl ms
 * returns { used, ttlMs }
 */
const ATTEMPT_SCRIPT = `
local ttlMs = tonumber(ARGV[1])

local used = redis.call('INCR', KEYS[1])
local ttl  = redis.call('PTTL', KEYS[1])

if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  ttl = ttlMs
end

return { used, ttl }
`;

/**
 * `eval` is typed `unknown` because a script can return anything, so the
 * reply is validated rather than asserted. The alternative is a cast, which
 * would turn a future script edit that changed the reply shape into silent
 * arithmetic on a security control — `NaN > limit` is `false`, so a broken
 * reply would read as "allowed" and the limiter would stop limiting without
 * failing. This throws instead, and the global filter turns a throw into a
 * 500: a rate limiter that cannot count must not answer 200.
 */
function replyElements(raw: unknown, length: number): unknown[] {
  if (!Array.isArray(raw) || raw.length !== length) {
    throw new TypeError('Rate limiter script returned an unexpected reply shape.');
  }
  return raw;
}

function toInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Rate limiter script returned a non-numeric value.');
  }
  return value;
}

function retryAfterSecondsFrom(ttlMs: number): number {
  // Floored at 1: `Retry-After: 0` reads as "retry now", which is the
  // opposite instruction.
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/**
 * Redis-backed rate limiting and attempt capping for the authentication
 * surface.
 *
 * **Why Redis and not a field on this object.** A counter in process memory is
 * a counter *per instance*: run the API on three pods and an attacker gets
 * three times the intended budget, because each pod only sees the requests
 * that happened to land on it. It also resets on every deploy, so the window
 * a limit is supposed to enforce is silently shortened to "since the last
 * release". For OTP that is not an abstract weakening — ADR-0008 § Security
 * requirements calls the rate limit a **financial** control, and the thing it
 * is defending is TezUsta's SMS bill. `docs/engineering/security.md` and
 * CLAUDE.md §12 ("no in-process state that two instances would disagree
 * about") say the same thing from the other direction. The state lives in
 * Redis so that N instances enforce ONE limit; `rate-limiter.service.test.ts`
 * asserts exactly that with two service instances on one Redis.
 *
 * **Why the subject is hashed.** The Redis key contains an HMAC of the phone
 * number, never the number. See {@link RateLimitConfig.keySecret}.
 *
 * This service is a primitive: it takes limits as arguments and has no
 * opinion about which endpoint deserves which. `RateLimitGuard` maps a policy
 * name to these numbers, and `rate-limit.config.ts` gets the numbers from
 * validated configuration.
 */
@Injectable()
export class RateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  /**
   * Counts one request against a limit and says whether it may proceed.
   *
   * Always counts, including the requests it denies — that is what drives the
   * backoff in {@link CONSUME_SCRIPT}, and it is also why a denied request
   * must not be retried in a loop by the caller.
   */
  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const key = this.limitKey(request.scope, request.dimension, request.subject);

    const reply = replyElements(
      await this.redis.eval(
        CONSUME_SCRIPT,
        1,
        key,
        String(request.limit),
        String(request.windowMs),
        String(request.backoffCeilingMs),
      ),
      3,
    );
    const count = toInteger(reply[0]);
    const ttlMs = toInteger(reply[1]);
    const allowed = toInteger(reply[2]);

    return {
      allowed: allowed === 1,
      dimension: request.dimension,
      limit: request.limit,
      remaining: Math.max(0, request.limit - count),
      resetAt: new Date(Date.now() + ttlMs),
      retryAfterSeconds: retryAfterSecondsFrom(ttlMs),
      subjectDigest: this.logDigest(request.scope, request.dimension, request.subject),
    };
  }

  /**
   * Counts one attempt against a short-lived secret and reports whether the
   * budget is now spent.
   *
   * The caller decides what "spent" costs. For OTP that is issue #29:
   * ADR-0008 requires the code to be invalidated once the cap is reached, and
   * that invalidation is #29's, not this module's — this service has no
   * knowledge of OTP records and must not grow any, or the cap and the thing
   * it caps end up owned by two modules that can disagree.
   */
  async consumeAttempt(request: AttemptRequest): Promise<AttemptTally> {
    const key = this.attemptKey(request.scope, request.subject);

    const reply = replyElements(
      await this.redis.eval(ATTEMPT_SCRIPT, 1, key, String(request.ttlMs)),
      2,
    );
    const used = toInteger(reply[0]);
    const ttlMs = toInteger(reply[1]);

    return {
      used,
      remaining: Math.max(0, request.maxAttempts - used),
      exhausted: used >= request.maxAttempts,
      expiresAt: new Date(Date.now() + ttlMs),
      subjectDigest: this.logDigest(request.scope, 'attempt', request.subject),
    };
  }

  /**
   * Drops a counter.
   *
   * Real uses, not just test cleanup: an admin clearing a limit a support
   * ticket proved was collateral damage from a carrier NAT, and — the common
   * one — a successful sign-in releasing the attempt budget so the next
   * sign-in starts clean instead of inheriting the last one's failures.
   */
  async reset(scope: string, dimension: RateLimitDimension, subject: string): Promise<void> {
    await this.redis.del(this.limitKey(scope, dimension, subject));
  }

  /** See {@link reset} — the attempt-counter equivalent. */
  async clearAttempts(scope: string, subject: string): Promise<void> {
    await this.redis.del(this.attemptKey(scope, subject));
  }

  private limitKey(scope: string, dimension: RateLimitDimension, subject: string): string {
    return `${KEY_PREFIX}:${scope}:${dimension}:${this.digest(scope, dimension, subject)}`;
  }

  private attemptKey(scope: string, subject: string): string {
    return `${KEY_PREFIX}:${scope}:attempt:${this.digest(scope, 'attempt', subject)}`;
  }

  /**
   * The scope and dimension are part of the HMAC input, not only of the key
   * name. That means the same phone number produces a different digest under
   * `otp-request` than under `sign-in`, so somebody reading the key space
   * cannot even correlate "this unknown person hit both endpoints" — the
   * counters are unlinkable, which costs nothing and removes a whole class of
   * inference.
   */
  private digest(scope: string, dimension: string, subject: string): string {
    return createHmac('sha256', this.config.keySecret)
      .update(`${scope}|${dimension}|${subject}`)
      .digest('hex')
      .slice(0, DIGEST_HEX_LENGTH);
  }

  private logDigest(scope: string, dimension: string, subject: string): string {
    return this.digest(scope, dimension, subject).slice(0, LOG_DIGEST_HEX_LENGTH);
  }
}
