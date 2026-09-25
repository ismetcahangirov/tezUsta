import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { RateLimitConfig, RateLimitPolicy } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import type { OutboundSms, SmsSender } from '../src/infra/sms/sms-sender.types';
import { SMS_SENDER } from '../src/infra/sms/sms-sender.types';
import { StubSmsSender } from '../src/infra/sms/stub-sms-sender';
import type { OtpConfig } from '../src/modules/auth/otp.config';
import { OTP_CONFIG } from '../src/modules/auth/otp.tokens';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The platform-wide daily OTP send cap (issue #272), end to end: real HTTP
 * through the real `AppModule` wiring, against a real Postgres and the shared
 * Redis — the same reasoning `auth.otp.e2e.test.ts` gives for driving this
 * surface over HTTP rather than unit-testing `OtpService` in isolation:
 * "exactly once, including concurrently" is a claim about what Redis does
 * with overlapping `INCR`s, and that does not survive a stub.
 *
 * A dedicated app instance and `OTP_CONFIG` override, rather than reusing
 * `auth.otp.e2e.test.ts`'s: that suite's cap is the real
 * `OTP_GLOBAL_DAILY_CAP` default (2000), which nothing in a test file should
 * come close to spending — this file exists specifically to drive a SMALL cap
 * to its boundary, repeatedly, without disturbing every other OTP test that
 * shares the same Redis instance.
 */

const GLOBAL_DAILY_CAP = 4;
const GLOBAL_DAILY_SCOPE = 'otp-global-daily';
const GLOBAL_DAILY_SUBJECT = 'global';

/** Deliberately unreachable in every dimension this suite does not test. */
const UNREACHABLE = 1_000_000;
const WINDOW_MS = 10_000;

function unreachablePolicy(): RateLimitPolicy {
  return {
    perIdentifier: UNREACHABLE,
    perIp: UNREACHABLE,
    windowMs: WINDOW_MS,
    backoffCeilingMs: WINDOW_MS,
  };
}

/**
 * Every per-phone and per-IP limit set far above anything this file could
 * possibly send. This suite is about the aggregate cap alone — the per-caller
 * limits are `auth.rate-limit.e2e.test.ts` and `auth.otp.e2e.test.ts`'s
 * concern, and a limit that fired here by accident would make a 429 look like
 * the 503 this file is testing for.
 */
const testRateLimits: RateLimitConfig = {
  keySecret: `otp-global-cap-e2e-pepper-${randomUUID()}`,
  policies: {
    'otp-request': unreachablePolicy(),
    'sign-in': unreachablePolicy(),
    refresh: unreachablePolicy(),
    geocode: unreachablePolicy(),
    'document-upload': unreachablePolicy(),
    'price-range': unreachablePolicy(),
    'order-creation': unreachablePolicy(),
    'order-transition': unreachablePolicy(),
    'offer-response': unreachablePolicy(),
    'offer-feed': unreachablePolicy(),
    'location-report': unreachablePolicy(),
    'device-registration': unreachablePolicy(),
    'message-send': unreachablePolicy(),
    'review-submit': unreachablePolicy(),
    'admin-setup': unreachablePolicy(),
    'admin-sign-in': unreachablePolicy(),
  },
};

/**
 * A self-contained `OtpConfig` with a cap small enough to reach in a handful
 * of requests. The pepper only has to be internally consistent for this
 * app's own request/verify round trip — nothing here reads
 * `process.env.OTP_CODE_PEPPER`.
 */
const testOtpConfig: OtpConfig = Object.freeze({
  codePepper: `otp-global-cap-e2e-code-pepper-${randomUUID()}`,
  length: 6,
  ttlMs: 300_000,
  maxAttempts: 5,
  globalDailyCap: GLOBAL_DAILY_CAP,
});

/** Wraps the real stub sender so a test can see exactly which numbers it was asked to send to. */
class CountingSmsSender implements SmsSender {
  readonly sentTo: string[] = [];

  constructor(private readonly inner: SmsSender) {}

  async send(message: OutboundSms): Promise<void> {
    this.sentTo.push(message.to);
    await this.inner.send(message);
  }
}

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let sms: CountingSmsSender;
let limiter: RateLimiterService;

let phoneCounter = 0;

/** A fresh, valid Azerbaijani number per call — `users.phone_e164` is unique among live rows. */
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

function postRequest(phone: string) {
  return request(app.getHttpServer()).post('/auth/otp/request').send({ phone });
}

async function resetGlobalDailyCounter(): Promise<void> {
  await limiter.clearAttempts(GLOBAL_DAILY_SCOPE, GLOBAL_DAILY_SUBJECT);
}

beforeAll(async () => {
  const baseUrl = parseEnv(process.env).database.url;
  database = await createThrowawayDatabase(baseUrl);
  await runMigrations(database.url);

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testRateLimits)
    .overrideProvider(OTP_CONFIG)
    .useValue(testOtpConfig)
    .overrideProvider(SMS_SENDER)
    .useValue(new CountingSmsSender(new StubSmsSender('test')))
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  sms = app.get<CountingSmsSender>(SMS_SENDER);
  limiter = app.get(RateLimiterService);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetGlobalDailyCounter();
  // `sms` is one `CountingSmsSender` shared by every test in this file — its
  // `sentTo` is cumulative unless cleared, and an absolute-length assertion in
  // one test would otherwise be counting sends a PREVIOUS test made too.
  sms.sentTo.length = 0;
});

afterAll(async () => {
  await app.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  await database.drop();
});

describe('the (cap + 1)th send in a window is refused without calling the sender', () => {
  it('serves exactly the capped number of requests, then answers the generic delivery error', async () => {
    for (let i = 0; i < GLOBAL_DAILY_CAP; i += 1) {
      const phone = nextPhone();
      const response = await postRequest(phone);
      expect(response.status).toBe(200);
      expect(sms.sentTo).toContain(phone);
    }

    const refusedPhone = nextPhone();
    const sentBeforeRefusal = sms.sentTo.length;
    const refused = await postRequest(refusedPhone);

    // The same generic answer ADR-0008 already gives for a provider outage —
    // an attacker must not be able to tell "the cap tripped" from "the
    // provider is down" by the shape of the response.
    expect(refused.status).toBe(503);
    const envelope = refused.body as ErrorEnvelope;
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(envelope.error.message).toBe(
      'The code could not be sent right now. Please try again shortly.',
    );

    // The sender was never reached for the refused request.
    expect(sms.sentTo).toHaveLength(sentBeforeRefusal);
    expect(sms.sentTo).not.toContain(refusedPhone);
  });
});

describe('concurrent requests at the boundary cannot overshoot the cap', () => {
  it('lets exactly the capped number of simultaneous requests through', async () => {
    const extra = 3;
    const phones = Array.from({ length: GLOBAL_DAILY_CAP + extra }, () => nextPhone());

    const responses = await Promise.all(phones.map((phone) => postRequest(phone)));

    const succeeded = responses.filter((response) => response.status === 200);
    const refused = responses.filter((response) => response.status === 503);

    // Never more than the cap, and never fewer — a guard that under-served
    // would be indistinguishable from one that leaked past the ceiling by a
    // different route, and either failure matters here.
    expect(succeeded).toHaveLength(GLOBAL_DAILY_CAP);
    expect(refused).toHaveLength(extra);
    expect(responses).toHaveLength(GLOBAL_DAILY_CAP + extra);

    for (const response of refused) {
      expect((response.body as ErrorEnvelope).error.code).toBe('INTERNAL_ERROR');
    }

    // The sender was asked to send exactly once per successful response —
    // never more (double-send) and never for a phone that was refused.
    expect(sms.sentTo).toHaveLength(GLOBAL_DAILY_CAP);
    expect(new Set(sms.sentTo).size).toBe(GLOBAL_DAILY_CAP);
  });
});

describe('the trip is logged once per window, without a phone number', () => {
  it('logs at error level exactly once, on the first refusal past the cap', async () => {
    // Spied directly on the `Logger` class method, the way
    // `auth.rate-limit.e2e.test.ts` asserts its own security-event logging —
    // this intercepts every call regardless of which sink the active logger
    // implementation (Nest's `TestingLogger` here) ultimately writes to.
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const phones: string[] = [];

    for (let i = 0; i < GLOBAL_DAILY_CAP; i += 1) {
      const phone = nextPhone();
      phones.push(phone);
      expect((await postRequest(phone)).status).toBe(200);
    }

    // Two refusals past the cap: the trip line must appear for the first one
    // only, not the second — `AllExceptionsFilter` also logs an `error` line
    // for every 5xx it sees, so this counts occurrences of the DISTINCT trip
    // message rather than every `error` call.
    const firstRefusedPhone = nextPhone();
    const secondRefusedPhone = nextPhone();
    phones.push(firstRefusedPhone, secondRefusedPhone);
    expect((await postRequest(firstRefusedPhone)).status).toBe(503);
    expect((await postRequest(secondRefusedPhone)).status).toBe(503);

    const allErrorText = errorSpy.mock.calls
      .flat()
      .map((argument) => String(argument))
      .join('\n');
    const trips = errorSpy.mock.calls
      .flat()
      .map((argument) => String(argument))
      .filter((line) => line.includes('otp global daily cap reached'));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toContain(`cap=${String(GLOBAL_DAILY_CAP)}`);

    // No phone number anywhere in what was logged at error level — this
    // counter has no per-caller subject, and none of the phones used to reach
    // it may leak either.
    for (const phone of phones) {
      expect(allErrorText).not.toContain(phone);
    }
  });

  it('logs nothing under this name while the cap has not been reached', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    for (let i = 0; i < GLOBAL_DAILY_CAP; i += 1) {
      expect((await postRequest(nextPhone())).status).toBe(200);
    }

    const trips = errorSpy.mock.calls
      .flat()
      .map((argument) => String(argument))
      .filter((line) => line.includes('otp global daily cap reached'));
    expect(trips).toHaveLength(0);
  });
});
