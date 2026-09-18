import { randomUUID } from 'node:crypto';

import { Controller, Get, Logger, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { RateLimit } from '../src/common/decorators/rate-limit.decorator';
import { Public } from '../src/modules/auth/public.decorator';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';

/**
 * Routes that exist only to put the real guard in front of real HTTP, the way
 * `health.e2e.test.ts` registers its `ThrowingController`. They never ship:
 * they are declared in this file and registered into this file's own testing
 * module alongside `AppModule`.
 *
 * Calling the guard directly would skip everything that actually has to work
 * for a 429 to reach a client — the global `APP_GUARD` registration, the
 * exception filter's translation of `RateLimitedError`, and the `Retry-After`
 * header, which only exists on a real reply.
 */
const PHONE_FIELD = 'phone';

function phoneFromBody(req: FastifyRequest): string | undefined {
  const { body } = req;
  if (typeof body !== 'object' || body === null || !(PHONE_FIELD in body)) {
    return undefined;
  }
  const value: unknown = (body as Record<string, unknown>)[PHONE_FIELD];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `@Public()` on the whole controller, because `AppModule`'s global
 * `AuthenticationGuard` (issue #27) protects every route that does not say
 * otherwise — including routes a test registers. Without it each route below
 * answers 401 before the rate-limit guard is reached, and this suite would be
 * asserting against the authentication guard rather than the one it is for.
 *
 * It also matches what these routes stand in for: the real OTP request and
 * verify endpoints (issue #29) are public by necessity — a caller who has no
 * token yet is exactly who they exist to serve, which is why they are the
 * endpoints that need a rate limit most.
 */
@Public()
@Controller('__test-only/rate-limit')
class RateLimitedController {
  /** Stands in for the OTP request endpoint issue #29 will build. */
  @Post('by-identifier')
  @RateLimit({ policy: 'otp-request', identifier: phoneFromBody })
  byIdentifier(): { ok: true } {
    return { ok: true };
  }

  /** No identifier extractor: only the per-IP dimension applies. */
  @Post('by-ip')
  @RateLimit({ policy: 'refresh' })
  byIp(): { ok: true } {
    return { ok: true };
  }

  /** No decorator at all — must never be limited. */
  @Get('unlimited')
  unlimited(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Deliberately NOT `@Public()`: a route that is both protected and rate
 * limited, which is what pins down the order the two global guards run in.
 */
@Controller('__test-only/rate-limit-protected')
class ProtectedRateLimitedController {
  @Post('guarded')
  @RateLimit({ policy: 'refresh' })
  guarded(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [RateLimitedController, ProtectedRateLimitedController] })
class RateLimitDebugModule {}

const IDENTIFIER_LIMIT = 2;
const IP_LIMIT = 2;
const WINDOW_MS = 10_000;

/**
 * Real policy names, test-sized numbers, and a pepper generated for this run.
 *
 * The pepper matters for more than isolation: because every Redis key is an
 * HMAC under it, this suite cannot collide with another checkout running
 * against the same shared Redis container, nor with its own previous run.
 * The windows are seconds rather than the configured hour so the suite
 * finishes; the *behaviour* under test — threshold, header, envelope,
 * indistinguishability — does not depend on the window's length.
 */
const testConfig: RateLimitConfig = {
  keySecret: `e2e-only-pepper-${randomUUID()}`,
  policies: {
    'otp-request': {
      perIdentifier: IDENTIFIER_LIMIT,
      // Deliberately unreachable: this policy is here to exercise the
      // identifier dimension, and an IP limit that also fired would make it
      // ambiguous which one produced the 429.
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    'sign-in': {
      perIdentifier: 100_000,
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    refresh: {
      perIdentifier: 100_000,
      perIp: IP_LIMIT,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    // Unreachable: this suite is about the authentication limits, and the
    // geocode policy is only here because the type requires every policy to be
    // present — a fixture that lies about the shape is a fixture that stops
    // compiling for the wrong reason later.
    geocode: {
      perIdentifier: 100_000,
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    'document-upload': {
      perIdentifier: 100_000,
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    'order-creation': {
      perIdentifier: 100_000,
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
    'price-range': {
      perIdentifier: 100_000,
      perIp: 100_000,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS * 6,
    },
  },
};

/** A real E.164 Azerbaijani mobile number — the value that must not leak. */
const KNOWN_PHONE = '+994501112233';
const UNKNOWN_PHONE = '+994559998877';
const NATIONAL_PART = '501112233';

let app: NestFastifyApplication;
let limiter: RateLimiterService;

const usedIdentifiers = new Set<string>();

async function post(path: string, body: Record<string, unknown>) {
  const phone = body[PHONE_FIELD];
  if (typeof phone === 'string') {
    usedIdentifiers.add(phone);
  }
  return request(app.getHttpServer()).post(`/__test-only/rate-limit/${path}`).send(body);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, RateLimitDebugModule],
  })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testConfig)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  limiter = app.get(RateLimiterService);
});

afterEach(async () => {
  vi.restoreAllMocks();

  // Never FLUSHDB — this Redis is shared. Delete exactly what was created.
  // Both loopback spellings, because which one Fastify reports for a
  // supertest connection depends on how the OS resolved the listen address.
  await Promise.all([
    ...[...usedIdentifiers].map((phone) => limiter.reset('otp-request', 'identifier', phone)),
    ...['127.0.0.1', '::ffff:127.0.0.1', '::1'].flatMap((ip) => [
      limiter.reset('otp-request', 'ip', ip),
      limiter.reset('refresh', 'ip', ip),
    ]),
  ]);
  usedIdentifiers.clear();
});

afterAll(async () => {
  await app.close();
});

describe('the rate-limit guard runs before the authentication guard', () => {
  it('answers 429, not 401, once an unauthenticated flood passes the limit', async () => {
    // Order here is a security property, not a detail. `RateLimitGuard` is
    // registered by `RateLimitModule`, which `AppModule` imports, while the
    // authentication guards are `AppModule`'s own providers — so Nest builds
    // the rate limiter first. If that ever inverted, an attacker could hammer
    // any protected endpoint for free by sending a junk token: every request
    // would stop at the 401 without ever being counted, and the limit that
    // exists to bound exactly that traffic would never fire.
    //
    // The first IP_LIMIT requests are refused by authentication (no token),
    // which is correct and expected; what matters is that they were COUNTED on
    // the way there, so the next one is refused by the limiter instead.
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const allowed = await request(app.getHttpServer())
        .post('/__test-only/rate-limit-protected/guarded')
        .send({});
      expect(allowed.status).toBe(401);
    }

    const limited = await request(app.getHttpServer())
      .post('/__test-only/rate-limit-protected/guarded')
      .send({});

    expect(limited.status).toBe(429);
    expect((limited.body as ErrorEnvelope).error.code).toBe('RATE_LIMITED');
  });
});

describe('rate limiting over real HTTP', () => {
  it('serves requests up to the configured limit and answers 429 for the next one', async () => {
    for (let i = 0; i < IDENTIFIER_LIMIT; i += 1) {
      const allowed = await post('by-identifier', { phone: KNOWN_PHONE });
      // 201, because Nest answers a POST with Created by default — the value
      // that matters is that it is not 429.
      expect(allowed.status).toBe(201);
    }

    const refused = await post('by-identifier', { phone: KNOWN_PHONE });
    expect(refused.status).toBe(429);
    expect((refused.body as ErrorEnvelope).error.code).toBe('RATE_LIMITED');
  });

  it('carries a retry hint in both the Retry-After header and the error envelope', async () => {
    for (let i = 0; i <= IDENTIFIER_LIMIT; i += 1) {
      await post('by-identifier', { phone: KNOWN_PHONE });
    }
    const refused = await post('by-identifier', { phone: KNOWN_PHONE });

    // The header is what a generic HTTP client honours; the envelope value is
    // what the mobile app reads through RTK Query, which never sees headers.
    const header = refused.headers['retry-after'];
    expect(Number(header)).toBeGreaterThan(0);

    const details = (refused.body as ErrorEnvelope).error.details;
    expect(typeof details?.retryAfterSeconds).toBe('number');
    expect(details?.retryAfterSeconds).toBe(Number(header));
  });

  it('limits per IP on a route that carries no identifier', async () => {
    for (let i = 0; i < IP_LIMIT; i += 1) {
      expect((await post('by-ip', {})).status).toBe(201);
    }

    // No body, no identifier, still limited: an unparseable or empty request
    // must never be a free request.
    expect((await post('by-ip', {})).status).toBe(429);
  });

  it('does not limit a route with no @RateLimit decorator', async () => {
    // The opposite default from the auth guard, and the reason is in the
    // decorator's own comment. A regression here would be a global default
    // limit quietly appearing on every endpoint in the service.
    for (let i = 0; i < IDENTIFIER_LIMIT * 5; i += 1) {
      const res = await request(app.getHttpServer()).get('/__test-only/rate-limit/unlimited');
      expect(res.status).toBe(200);
    }
  });
});

describe('rate limiting does not become a user-enumeration oracle', () => {
  async function exhaust(phone: string) {
    for (let i = 0; i < IDENTIFIER_LIMIT; i += 1) {
      await post('by-identifier', { phone });
    }
    return post('by-identifier', { phone });
  }

  it('answers identically for a known and an unknown identifier', async () => {
    const known = await exhaust(KNOWN_PHONE);
    const unknown = await exhaust(UNKNOWN_PHONE);

    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);

    // `requestId` is unique per request by design and is the only field that
    // may differ; normalise it and the two responses must be byte-identical.
    // Nothing else in the 429 path consults a user store — that is the
    // property, and this is what would catch a well-meaning future change
    // that made the message say "no account for this number".
    const normalise = (text: string): string =>
      text.replace(/"requestId":"[^"]*"/, '"requestId":"<id>"');

    expect(normalise(known.text)).toBe(normalise(unknown.text));
  });
});

describe('the phone number never leaves the process in the clear', () => {
  it('appears in no log line, no response body, and no Redis key', async () => {
    // The guard logs a security event on every refusal. Capture what it
    // actually wrote rather than trusting the code to be careful —
    // docs/engineering/security.md forbids the full number in logs, and a
    // template-string edit is all it takes to put it back.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    for (let i = 0; i <= IDENTIFIER_LIMIT; i += 1) {
      await post('by-identifier', { phone: KNOWN_PHONE });
    }
    const refused = await post('by-identifier', { phone: KNOWN_PHONE });
    expect(refused.status).toBe(429);

    // A refusal has to be logged at all — a security control that records
    // nothing is one nobody can investigate.
    expect(warn).toHaveBeenCalled();

    const written = [warn, error, log]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
      .join('\n');

    expect(written).not.toContain(KNOWN_PHONE);
    expect(written).not.toContain(NATIONAL_PART);

    const wire = `${refused.text}\n${JSON.stringify(refused.headers)}`;
    expect(wire).not.toContain(KNOWN_PHONE);
    expect(wire).not.toContain(NATIONAL_PART);

    // And the key space. `KEYS`/`MONITOR` are available to anyone with Redis
    // access, so a key naming the caller is a stored phone number by another
    // route (docs/engineering/security.md § PII and privacy).
    const redis = app.get<Redis>(REDIS_CLIENT);
    const keys = await redis.keys('rl:v1:otp-request:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(KNOWN_PHONE);
      expect(key).not.toContain(NATIONAL_PART);
    }
  });
});
