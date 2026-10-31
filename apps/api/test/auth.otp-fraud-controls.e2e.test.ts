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
import type { EmailSender, OutboundEmail } from '../src/infra/email/email-sender.types';
import { EMAIL_SENDER } from '../src/infra/email/email-sender.types';
import type { RateLimitConfig, RateLimitPolicy } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import type { OtpConfig } from '../src/modules/auth/otp.config';
import { hourBucket } from '../src/modules/auth/otp.service';
import { OTP_CONFIG } from '../src/modules/auth/otp.tokens';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The OTP fraud controls behind the daily cap (#390, ADR-0072 § 4), through
 * the real `AppModule` and Redis: the hourly ceiling and the circuit breaker
 * on codes entered. The per-prefix and per-range caps went with the phone
 * number: they were keyed on its structure, which an email address does not
 * have.
 *
 * Every per-caller limit is made unreachable, as `auth.otp-global-cap.e2e`
 * does, so a refusal here can only be the control under test. Every test
 * uses fresh addresses, and the counters are cleared between tests.
 */

const HOURLY_CAP = 12;
const BREAKER_MIN_SENDS = 6;
const BREAKER_MIN_SUCCESS_PERCENT = 50;

function unreachablePolicy(): RateLimitPolicy {
  return {
    perIdentifier: 1_000_000,
    perIp: 1_000_000,
    windowMs: 10_000,
    backoffCeilingMs: 10_000,
  };
}

const testRateLimits: RateLimitConfig = {
  keySecret: `otp-fraud-e2e-pepper-${randomUUID()}`,
  policies: {
    'otp-request': unreachablePolicy(),
    'sign-in': unreachablePolicy(),
    refresh: unreachablePolicy(),
    geocode: unreachablePolicy(),
    'document-upload': unreachablePolicy(),
    'price-range': unreachablePolicy(),
    'order-creation': unreachablePolicy(),
    'order-transition': unreachablePolicy(),
    'order-search-read': unreachablePolicy(),
    'offer-response': unreachablePolicy(),
    'offer-feed': unreachablePolicy(),
    'location-report': unreachablePolicy(),
    'device-registration': unreachablePolicy(),
    'message-send': unreachablePolicy(),
    'review-submit': unreachablePolicy(),
    'report-submit': unreachablePolicy(),
    'portfolio-upload': unreachablePolicy(),
    'portfolio-write': unreachablePolicy(),
    'subscription-checkout': unreachablePolicy(),
    'profile-read': unreachablePolicy(),
    'admin-setup': unreachablePolicy(),
    'admin-sign-in': unreachablePolicy(),
  },
};

const testOtpConfig: OtpConfig = Object.freeze({
  codePepper: `otp-fraud-e2e-code-pepper-${randomUUID()}`,
  length: 6,
  ttlMs: 300_000,
  maxAttempts: 5,
  globalDailyCap: 1_000,
  globalHourlyCap: HOURLY_CAP,
  breakerMinSends: BREAKER_MIN_SENDS,
  breakerMinSuccessPercent: BREAKER_MIN_SUCCESS_PERCENT,
});

/** Records what was sent, so a test can read the code an address was given. */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutboundEmail[] = [];

  send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  codeFor(email: string): string {
    const message = [...this.sent].reverse().find((candidate) => candidate.to === email);
    const code = message?.text.match(/^\d{6}/)?.[0];
    if (code === undefined) {
      throw new Error('No code was sent to that address.');
    }
    return code;
  }
}

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let mail: RecordingEmailSender;
let limiter: RateLimiterService;
let serial = 0;

/** A fresh address per call; the controls under test count every address alike. */
function address(): string {
  serial += 1;
  return `fraud-${String(serial)}@example.com`;
}

function requestCode(to: string) {
  return request(app.getHttpServer()).post('/auth/otp/request').send({ email: to });
}

function verify(to: string, code: string) {
  return request(app.getHttpServer()).post('/auth/otp/verify').send({ email: to, code });
}

function expectGenericRefusal(response: request.Response): void {
  expect(response.status).toBe(503);
  expect((response.body as ErrorEnvelope).error.code).toBe('INTERNAL_ERROR');
}

/**
 * Drops every #390 counter for this hour and the last — all platform-wide,
 * keyed by hour, spelled the way `OtpService` builds them.
 */
async function clearCounters(): Promise<void> {
  const now = new Date();
  const hours = [hourBucket(now), hourBucket(new Date(now.getTime() - 3_600_000))];
  const clears: Promise<void>[] = [];
  for (const hour of hours) {
    for (const scope of [
      'otp-global-hourly',
      'otp-breaker-sent',
      'otp-breaker-verified',
      'otp-breaker-tripped',
    ]) {
      clears.push(limiter.clearAttempts(scope, hour));
    }
  }
  await Promise.all(clears);
}

beforeAll(async () => {
  database = await createThrowawayDatabase(parseEnv(process.env).database.url);
  await runMigrations(database.url);
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testRateLimits)
    .overrideProvider(OTP_CONFIG)
    .useValue(testOtpConfig)
    .overrideProvider(EMAIL_SENDER)
    .useValue(new RecordingEmailSender())
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  mail = app.get<RecordingEmailSender>(EMAIL_SENDER);
  limiter = app.get(RateLimiterService);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await clearCounters();
  mail.sent.length = 0;
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

describe('the hourly ceiling (#390)', () => {
  it('refuses past the hourly cap across distinct addresses, and logs it once without an address', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < HOURLY_CAP; i += 1) {
      const to = address();
      expect((await requestCode(to)).status).toBe(200);
      // Real customers enter their codes, which keeps the breaker shut, so
      // the refusal below is the hourly cap's and nothing else's.
      expect((await verify(to, mail.codeFor(to))).status).toBe(200);
    }

    const refusedOnce = address();
    expectGenericRefusal(await requestCode(refusedOnce));
    expectGenericRefusal(await requestCode(address()));
    expect(mail.sent.map((message) => message.to)).not.toContain(refusedOnce);

    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('otp-global-hourly cap reached'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(refusedOnce);
  });
});

describe('the circuit breaker (#390)', () => {
  /** Requests a code for each of `count` fresh addresses. */
  async function send(count: number): Promise<string[]> {
    const emails: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const to = address();
      expect((await requestCode(to)).status).toBe(200);
      emails.push(to);
    }
    return emails;
  }

  it('opens when too few sent codes are entered, refusing every address, and says so once', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await send(BREAKER_MIN_SENDS);

    const blocked = address();
    expectGenericRefusal(await requestCode(blocked));
    expectGenericRefusal(await requestCode(address()));
    expect(mail.sent.map((message) => message.to)).not.toContain(blocked);

    const opened = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('circuit breaker open'));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`0 of ${String(BREAKER_MIN_SENDS)}`);
  });

  it('stays closed while enough codes are entered', async () => {
    const emails = await send(BREAKER_MIN_SENDS);
    for (const to of emails.slice(0, BREAKER_MIN_SENDS / 2)) {
      expect((await verify(to, mail.codeFor(to))).status).toBe(200);
    }

    expect((await requestCode(address())).status).toBe(200);
  });

  it('stays closed below its minimum sample, however few codes were entered', async () => {
    await send(BREAKER_MIN_SENDS - 1);

    expect((await requestCode(address())).status).toBe(200);
  });
});
