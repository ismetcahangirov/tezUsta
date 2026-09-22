import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RateLimitConfig } from './rate-limit.config';
import type { RateLimitDimension, RateLimitRequest } from './rate-limit.types';
import { RateLimiterService } from './rate-limiter.service';

// Real Redis, not a fake. A fake would answer whatever this file told it to,
// and every property under test here — atomicity of INCR+PEXPIRE, TTL
// behaviour, two processes agreeing on one counter — is a property OF Redis.
// Testing it against a stand-in would prove the stand-in correct
// (docs/engineering/testing-strategy.md). `docker compose up -d` must be
// running; `test/setup-env.ts` supplies REDIS_URL.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Every key this file creates is an HMAC under a pepper generated fresh for
 * this run, and every scope carries a fresh UUID. Two consequences, both
 * deliberate: the suite cannot collide with another checkout using the same
 * shared Redis container, and it cannot collide with its own previous run.
 * Cleanup below is still explicit — a leaked key with an hour-long TTL is
 * litter in somebody else's database.
 */
const RUN_ID = randomUUID();

const config: RateLimitConfig = {
  keySecret: `test-only-pepper-${RUN_ID}`,
  // Unused by the service — only the guard reads policies — but the type
  // requires them, and a fixture that lies about the shape is a fixture that
  // stops compiling for the wrong reason later.
  policies: {
    'otp-request': {
      perIdentifier: 5,
      perIp: 20,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'sign-in': { perIdentifier: 10, perIp: 30, windowMs: 3_600_000, backoffCeilingMs: 3_600_000 },
    refresh: { perIdentifier: 60, perIp: 120, windowMs: 3_600_000, backoffCeilingMs: 3_600_000 },
    geocode: { perIdentifier: 60, perIp: 120, windowMs: 3_600_000, backoffCeilingMs: 3_600_000 },
    'document-upload': {
      perIdentifier: 30,
      perIp: 60,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'price-range': {
      perIdentifier: 120,
      perIp: 300,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'order-creation': {
      perIdentifier: 20,
      perIp: 40,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'order-transition': {
      perIdentifier: 20,
      perIp: 40,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'offer-response': {
      perIdentifier: 300,
      perIp: 3000,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'offer-feed': {
      perIdentifier: 900,
      perIp: 9000,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'location-report': {
      perIdentifier: 600,
      perIp: 3000,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'device-registration': {
      perIdentifier: 60,
      perIp: 600,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
    'message-send': {
      perIdentifier: 60,
      perIp: 600,
      windowMs: 3_600_000,
      backoffCeilingMs: 3_600_000,
    },
  },
};

/** A realistic Azerbaijani mobile number in E.164 — the PII under test. */
const PHONE = '+994501112233';

let redis: Redis;
let limiter: RateLimiterService;

/** Everything created during a test, torn down after it. */
const createdLimits: { scope: string; dimension: RateLimitDimension; subject: string }[] = [];
const createdAttempts: { scope: string; subject: string }[] = [];

function scopeFor(name: string): string {
  return `test-${name}-${randomUUID()}`;
}

async function consume(request: RateLimitRequest) {
  createdLimits.push({
    scope: request.scope,
    dimension: request.dimension,
    subject: request.subject,
  });
  return limiter.consume(request);
}

/**
 * Default: a minute-long window with backoff disabled (ceiling == window), so
 * a slow machine cannot expire a counter mid-test and turn a real off-by-one
 * into a green run. The tests that are ABOUT expiry or backoff say so by
 * overriding both fields.
 */
function limitFor(overrides: Partial<RateLimitRequest> & { scope: string }): RateLimitRequest {
  return {
    dimension: 'identifier',
    subject: PHONE,
    limit: 3,
    windowMs: 60_000,
    backoffCeilingMs: 60_000,
    ...overrides,
  };
}

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
});

afterEach(async () => {
  await Promise.all([
    ...createdLimits.map((k) => limiter.reset(k.scope, k.dimension, k.subject)),
    ...createdAttempts.map((k) => limiter.clearAttempts(k.scope, k.subject)),
  ]);
  createdLimits.length = 0;
  createdAttempts.length = 0;
});

afterAll(() => {
  redis.disconnect();
});

beforeAll(() => {
  limiter = new RateLimiterService(redis, config);
});

describe('RateLimiterService — the limit itself', () => {
  it('allows exactly the configured number of requests and refuses the next one', async () => {
    const scope = scopeFor('threshold');
    const request = limitFor({ scope, limit: 3 });

    // Off-by-one in either direction is the failure this asserts against: a
    // limiter that refuses the third request enforces 2, and one that allows
    // the fourth enforces 4. Both look like "rate limiting works".
    const first = await consume(request);
    const second = await consume(request);
    const third = await consume(request);
    const fourth = await consume(request);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(fourth.allowed).toBe(false);
  });

  it('reports how many requests remain and when the window resets', async () => {
    const scope = scopeFor('remaining');
    const request = limitFor({ scope, limit: 3, windowMs: 60_000, backoffCeilingMs: 60_000 });

    expect((await consume(request)).remaining).toBe(2);
    expect((await consume(request)).remaining).toBe(1);
    const third = await consume(request);
    expect(third.remaining).toBe(0);

    // A caller must be able to answer a 429 without a second round trip.
    expect(third.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(third.resetAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // Never a running deficit: an over-limit caller has zero left, not -4.
    await consume(request);
    expect((await consume(request)).remaining).toBe(0);
  });

  it('lets the caller through again once the window has elapsed', async () => {
    const scope = scopeFor('reset');
    const request = limitFor({ scope, limit: 2, windowMs: 1_000, backoffCeilingMs: 1_000 });

    await consume(request);
    await consume(request);
    expect((await consume(request)).allowed).toBe(false);

    // Redis's own TTL is the clock. The alternative — faking `Date.now()` —
    // would prove this code's arithmetic and say nothing about whether the
    // key actually expires, which is the thing that has to be true.
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    expect((await consume(request)).allowed).toBe(true);
  });

  it('enforces the per-identifier and per-IP limits independently', async () => {
    const scope = scopeFor('dimensions');
    const byPhone: RateLimitRequest = limitFor({ scope, dimension: 'identifier', limit: 2 });
    const byIp: RateLimitRequest = limitFor({
      scope,
      dimension: 'ip',
      subject: '203.0.113.7',
      limit: 2,
    });

    // Spend the phone budget to exhaustion.
    await consume(byPhone);
    await consume(byPhone);
    expect((await consume(byPhone)).allowed).toBe(false);

    // The IP budget must be untouched — a caller who exhausted one axis has
    // not spent the other, or the two limits are really one limit with two
    // names and the per-IP protection against number-rotation is imaginary.
    const firstFromIp = await consume(byIp);
    expect(firstFromIp.allowed).toBe(true);
    expect(firstFromIp.remaining).toBe(1);
  });

  it('backs off: each request made while already over the limit pushes the reset further out', async () => {
    const scope = scopeFor('backoff');
    // A 4-second window with a 20-second ceiling: each refusal adds another
    // window, so the wait climbs 8, 12, 16, 20, 20, 20…
    const request = limitFor({ scope, limit: 1, windowMs: 4_000, backoffCeilingMs: 20_000 });

    await consume(request);

    const denials = [];
    for (let i = 0; i < 6; i += 1) {
      denials.push(await consume(request));
    }

    expect(denials.every((denial) => !denial.allowed)).toBe(true);

    // Hammering has to cost the hammerer something, or "retry immediately" is
    // a free strategy and the window is only ever as long as it started.
    const [first, second, third] = denials;
    expect(first?.retryAfterSeconds).toBeGreaterThan(4);
    expect(second?.retryAfterSeconds).toBeGreaterThan(first?.retryAfterSeconds ?? 0);
    expect(third?.retryAfterSeconds).toBeGreaterThan(second?.retryAfterSeconds ?? 0);

    // The ceiling holds — backoff must not grow without bound, or one
    // determined attacker locks a carrier NAT out for a day.
    for (const denial of denials) {
      expect(denial.retryAfterSeconds).toBeLessThanOrEqual(20);
    }
  });

  it('applies no backoff at all when the ceiling equals the window', async () => {
    const scope = scopeFor('no-backoff');
    // `AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER=1` produces exactly this, and
    // `.env.example` documents it as "disables backoff". It has to actually
    // disable it — clamping to a ceiling equal to the window would otherwise
    // still restart a half-spent window on every refusal, which is a rolling
    // block, not a plain one.
    const request = limitFor({ scope, limit: 1, windowMs: 10_000, backoffCeilingMs: 10_000 });

    await consume(request);
    const first = await consume(request);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const later = await consume(request);

    // The absolute reset instant must not move forward. It is allowed to
    // drift by a millisecond or two — `resetAt` is `now + PTTL`, and the two
    // are read a moment apart — but an implementation that extended the
    // window here would push it a whole window into the future, which is
    // three orders of magnitude outside this tolerance.
    expect(later.resetAt.getTime()).toBeLessThanOrEqual(first.resetAt.getTime() + 50);
  });
});

describe('RateLimiterService — atomicity and shared state', () => {
  it('admits exactly the configured number under genuinely concurrent calls', async () => {
    const scope = scopeFor('concurrent');
    const request = limitFor({ scope, limit: 10, windowMs: 5_000, backoffCeilingMs: 5_000 });

    // `Promise.all`, not a loop: these are in flight together, which is the
    // only arrangement that can catch a read-then-write limiter. A
    // check-then-increment implementation passes every sequential test in
    // this file and admits far more than ten here.
    const decisions = await Promise.all(Array.from({ length: 50 }, () => consume(request)));

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(40);
  });

  it('never leaves a counter without an expiry, so a caller cannot be locked out forever', async () => {
    const scope = scopeFor('ttl');
    const request = limitFor({ scope, limit: 1, windowMs: 5_000, backoffCeilingMs: 5_000 });

    await consume(request);

    // The failure this guards against: INCR and PEXPIRE as two round trips,
    // with the process dying in between. PTTL of -1 means an immortal key and
    // a permanently limited subject that no window will ever clear.
    const keys = await redis.keys(`rl:v1:${scope}:*`);
    expect(keys).toHaveLength(1);
    for (const key of keys) {
      expect(await redis.pttl(key)).toBeGreaterThan(0);
    }
  });

  it('two service instances sharing one Redis enforce ONE limit, not one each', async () => {
    const scope = scopeFor('shared');
    const request = limitFor({ scope, limit: 4, windowMs: 10_000, backoffCeilingMs: 10_000 });

    // Two clients and two services stand in for two API instances behind a
    // load balancer. This is the entire reason the state is in Redis
    // (ADR-0008: "an in-process counter is per-instance, so N instances mean
    // an N× weaker limit"), so an implementation that regressed to a field on
    // the service would let all eight requests through here and pass every
    // other test in this file.
    const clientB = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const limiterB = new RateLimiterService(clientB, config);
    createdLimits.push({ scope, dimension: request.dimension, subject: request.subject });

    try {
      const results = [
        await limiter.consume(request),
        await limiterB.consume(request),
        await limiter.consume(request),
        await limiterB.consume(request),
        await limiter.consume(request),
        await limiterB.consume(request),
      ];

      expect(results.map((result) => result.allowed)).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
      ]);
    } finally {
      clientB.disconnect();
    }
  });

  it('forgets a counter on reset', async () => {
    const scope = scopeFor('manual-reset');
    const request = limitFor({ scope, limit: 1, windowMs: 60_000, backoffCeilingMs: 60_000 });

    await consume(request);
    expect((await consume(request)).allowed).toBe(false);

    await limiter.reset(request.scope, request.dimension, request.subject);

    expect((await consume(request)).allowed).toBe(true);
  });
});

describe('RateLimiterService — the subject never reaches Redis in the clear', () => {
  it('puts no part of the phone number in the Redis key', async () => {
    const scope = scopeFor('privacy');
    await consume(limitFor({ scope, subject: PHONE, windowMs: 60_000 }));

    const keys = await redis.keys(`rl:v1:${scope}:*`);
    expect(keys).toHaveLength(1);

    for (const key of keys) {
      // The whole number, and the national part without the country code —
      // a key containing `501112233` is just as much a stored phone number.
      expect(key).not.toContain(PHONE);
      expect(key).not.toContain('501112233');
      // Nothing but the scope, the dimension and hex.
      expect(key).toMatch(new RegExp(`^rl:v1:${scope}:identifier:[0-9a-f]{32}$`));
    }
  });

  it('reports a digest for logging that reveals neither the number nor which policy it reused', async () => {
    const scopeA = scopeFor('digest-a');
    const scopeB = scopeFor('digest-b');

    const underA = await consume(limitFor({ scope: scopeA, subject: PHONE, windowMs: 60_000 }));
    const underB = await consume(limitFor({ scope: scopeB, subject: PHONE, windowMs: 60_000 }));

    expect(underA.subjectDigest).not.toContain('501112233');
    expect(underA.subjectDigest).toMatch(/^[0-9a-f]{12}$/);

    // Same person, two policies, two unlinkable digests: someone reading the
    // logs cannot join "this unknown subject hit OTP request" to "this
    // unknown subject hit sign-in".
    expect(underA.subjectDigest).not.toBe(underB.subjectDigest);

    // Stable within a policy, or the digest would be useless for correlating
    // repeated abuse from one source.
    const againUnderA = await consume(
      limitFor({ scope: scopeA, subject: PHONE, windowMs: 60_000 }),
    );
    expect(againUnderA.subjectDigest).toBe(underA.subjectDigest);
  });
});

describe('RateLimiterService — the attempt cap (the primitive issue #29 consumes)', () => {
  function attempt(scope: string, subject: string, maxAttempts = 5, ttlMs = 60_000) {
    createdAttempts.push({ scope, subject });
    return limiter.consumeAttempt({ scope, subject, maxAttempts, ttlMs });
  }

  it('counts attempts and reports exhaustion exactly at the cap', async () => {
    const scope = scopeFor('attempts');
    const challengeId = randomUUID();

    const tallies = [];
    for (let i = 0; i < 5; i += 1) {
      tallies.push(await attempt(scope, challengeId, 5));
    }

    expect(tallies.map((tally) => tally.used)).toEqual([1, 2, 3, 4, 5]);
    expect(tallies.map((tally) => tally.remaining)).toEqual([4, 3, 2, 1, 0]);
    // ADR-0008: "max 5 attempts per code, then invalidate". Exhausted on the
    // fifth, not the sixth — the fifth guess is the last one allowed, and a
    // cap that only reports itself spent after a sixth has let six through.
    expect(tallies.map((tally) => tally.exhausted)).toEqual([false, false, false, false, true]);
  });

  it('keeps counting past the cap so a caller cannot un-exhaust a code by guessing more', async () => {
    const scope = scopeFor('attempts-past-cap');
    const challengeId = randomUUID();

    for (let i = 0; i < 5; i += 1) {
      await attempt(scope, challengeId, 5);
    }
    const sixth = await attempt(scope, challengeId, 5);

    expect(sixth.used).toBe(6);
    expect(sixth.remaining).toBe(0);
    expect(sixth.exhausted).toBe(true);
  });

  it('gives each code its own budget, so a new code is not born already spent', async () => {
    const scope = scopeFor('attempts-per-code');
    const firstCode = randomUUID();
    const secondCode = randomUUID();

    for (let i = 0; i < 5; i += 1) {
      await attempt(scope, firstCode, 5);
    }

    // The subject is the challenge id, not the phone number, precisely so
    // that burning one code's attempts cannot lock out the next one the user
    // legitimately requests.
    const freshCode = await attempt(scope, secondCode, 5);
    expect(freshCode.used).toBe(1);
    expect(freshCode.exhausted).toBe(false);
  });

  it('never extends the attempt window, so the counter dies with the code it guards', async () => {
    const scope = scopeFor('attempts-ttl');
    const challengeId = randomUUID();

    const first = await attempt(scope, challengeId, 5, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await attempt(scope, challengeId, 5, 5_000);

    // A counter whose TTL was refreshed on every attempt would outlive the
    // OTP code and cap the NEXT one. The absolute expiry instant must stay
    // put (±a millisecond of read skew); a refresh would push it 1.1 seconds
    // out, far outside this tolerance.
    expect(second.expiresAt.getTime()).toBeLessThanOrEqual(first.expiresAt.getTime() + 50);
  });

  it('clears an attempt budget on demand, which is what a successful verification does', async () => {
    const scope = scopeFor('attempts-clear');
    const challengeId = randomUUID();

    await attempt(scope, challengeId, 2);
    await attempt(scope, challengeId, 2);

    await limiter.clearAttempts(scope, challengeId);

    expect((await attempt(scope, challengeId, 2)).used).toBe(1);
  });

  it('keeps the phone number out of the attempt key as well', async () => {
    const scope = scopeFor('attempts-privacy');
    await attempt(scope, PHONE, 5);

    const keys = await redis.keys(`rl:v1:${scope}:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('501112233');
    expect(keys[0]).toMatch(new RegExp(`^rl:v1:${scope}:attempt:[0-9a-f]{32}$`));
  });
});
