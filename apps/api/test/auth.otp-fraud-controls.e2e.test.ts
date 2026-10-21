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
import type { OtpConfig } from '../src/modules/auth/otp.config';
import { hourBucket } from '../src/modules/auth/otp.service';
import { OTP_CONFIG } from '../src/modules/auth/otp.tokens';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The OTP fraud controls behind the daily cap (#390, ADR-0059), through the
 * real `AppModule` and Redis: the hourly ceiling, the per-prefix and
 * per-range caps, and the circuit breaker on codes entered.
 *
 * Every per-caller limit is made unreachable, as `auth.otp-global-cap.e2e`
 * does, so a refusal here can only be the control under test. Each test uses
 * its own operator prefix, and the counters are cleared between tests.
 */

const RANGE_CAP = 2;
const PREFIX_CAP = 4;
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
  prefixHourlyCap: PREFIX_CAP,
  rangeHourlyCap: RANGE_CAP,
  breakerMinSends: BREAKER_MIN_SENDS,
  breakerMinSuccessPercent: BREAKER_MIN_SUCCESS_PERCENT,
});

/** Records what was sent, so a test can read the code a number was given. */
class RecordingSmsSender implements SmsSender {
  readonly sent: OutboundSms[] = [];

  send(message: OutboundSms): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  codeFor(phone: string): string {
    const message = [...this.sent].reverse().find((candidate) => candidate.to === phone);
    const code = message?.body.match(/^\d{6}/)?.[0];
    if (code === undefined) {
      throw new Error('No code was sent to that number.');
    }
    return code;
  }
}

/** Every number this file asked a code for, so its prefix and range counters can be cleared. */
const used = new Set<string>();

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let sms: RecordingSmsSender;
let limiter: RateLimiterService;
let serial = 0;

/** A fresh number in range `+994{op}{range}…`, so a test decides which counters it shares. */
function phone(operator: string, range: string): string {
  serial += 1;
  const to = `+994${operator}${range}${String(serial % 10_000).padStart(4, '0')}`;
  used.add(to);
  return to;
}

function requestCode(to: string) {
  return request(app.getHttpServer()).post('/auth/otp/request').send({ phone: to });
}

function verify(to: string, code: string) {
  return request(app.getHttpServer()).post('/auth/otp/verify').send({ phone: to, code });
}

function expectGenericRefusal(response: request.Response): void {
  expect(response.status).toBe(503);
  expect((response.body as ErrorEnvelope).error.code).toBe('INTERNAL_ERROR');
}

/**
 * Drops every #390 counter for this hour and the last: the platform-wide ones
 * by hour, and each used number's prefix and range — the subjects
 * `OtpService` builds, spelled the same way.
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
    for (const to of used) {
      clears.push(limiter.clearAttempts('otp-prefix-hourly', `${hour}|${to.slice(0, 6)}`));
      clears.push(limiter.clearAttempts('otp-range-hourly', `${hour}|${to.slice(0, 9)}`));
    }
  }
  await Promise.all(clears);
  used.clear();
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
    .overrideProvider(SMS_SENDER)
    .useValue(new RecordingSmsSender())
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  sms = app.get<RecordingSmsSender>(SMS_SENDER);
  limiter = app.get(RateLimiterService);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await clearCounters();
  sms.sent.length = 0;
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

describe('the per-range cap (#390)', () => {
  it('refuses a third number in one range of ten thousand, and still sends to the next range', async () => {
    const first = await requestCode(phone('50', '100'));
    const second = await requestCode(phone('50', '100'));
    const third = phone('50', '100');
    const refused = await requestCode(third);

    expect([first.status, second.status]).toEqual([200, 200]);
    expectGenericRefusal(refused);
    expect(sms.sent.map((message) => message.to)).not.toContain(third);

    expect((await requestCode(phone('50', '101'))).status).toBe(200);
  });
});

describe('the per-prefix cap (#390)', () => {
  it('refuses past the cap on one operator prefix, across its ranges, and not on another', async () => {
    for (let range = 0; range < PREFIX_CAP; range += 1) {
      expect((await requestCode(phone('51', `20${String(range)}`))).status).toBe(200);
    }

    expectGenericRefusal(await requestCode(phone('51', '209')));
    expect((await requestCode(phone('55', '200'))).status).toBe(200);
  });
});

describe('the hourly ceiling (#390)', () => {
  it('refuses past the hourly cap however the numbers are spread, and logs it once without a number', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const operators = ['10', '50', '51', '55', '60', '70', '77', '99'];
    for (let i = 0; i < HOURLY_CAP; i += 1) {
      const operator = operators[i % operators.length] ?? '50';
      const to = phone(operator, `3${String(i).padStart(2, '0')}`);
      expect((await requestCode(to)).status).toBe(200);
      // Real customers enter their codes, which keeps the breaker shut, so
      // the refusal below is the hourly cap's and nothing else's.
      expect((await verify(to, sms.codeFor(to))).status).toBe(200);
    }

    const refusedOnce = phone('77', '399');
    expectGenericRefusal(await requestCode(refusedOnce));
    expectGenericRefusal(await requestCode(phone('99', '399')));

    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('otp-global-hourly cap reached'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(refusedOnce.slice(4));
  });
});

describe('the circuit breaker (#390)', () => {
  /** Requests a code for each of `count` numbers spread across prefixes and ranges. */
  async function send(count: number, offset: number): Promise<string[]> {
    const operators = ['10', '50', '51', '55', '60', '70'];
    const phones: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const to = phone(
        operators[(i + offset) % operators.length] ?? '50',
        `4${String(i + offset).padStart(2, '0')}`,
      );
      expect((await requestCode(to)).status).toBe(200);
      phones.push(to);
    }
    return phones;
  }

  it('opens when too few sent codes are entered, refusing every number, and says so once', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await send(BREAKER_MIN_SENDS, 0);

    const blocked = phone('99', '499');
    expectGenericRefusal(await requestCode(blocked));
    expectGenericRefusal(await requestCode(phone('77', '499')));
    expect(sms.sent.map((message) => message.to)).not.toContain(blocked);

    const opened = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('circuit breaker open'));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`0 of ${String(BREAKER_MIN_SENDS)}`);
  });

  it('stays closed while enough codes are entered', async () => {
    const phones = await send(BREAKER_MIN_SENDS, 20);
    for (const to of phones.slice(0, BREAKER_MIN_SENDS / 2)) {
      expect((await verify(to, sms.codeFor(to))).status).toBe(200);
    }

    expect((await requestCode(phone('99', '450'))).status).toBe(200);
  });

  it('stays closed below its minimum sample, however few codes were entered', async () => {
    await send(BREAKER_MIN_SENDS - 1, 40);

    expect((await requestCode(phone('99', '470'))).status).toBe(200);
  });
});
