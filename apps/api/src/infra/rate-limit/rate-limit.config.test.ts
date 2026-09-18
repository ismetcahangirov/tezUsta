import { describe, expect, it } from 'vitest';

import { parseEnv } from '../config/parse-env';
import { createRateLimitConfig, MissingRateLimitKeySecretError } from './rate-limit.config';

/**
 * Built through the real `parseEnv` rather than a hand-written `AppConfig`
 * literal, so this file cannot drift from the schema it is asserting against
 * — the same approach `auth.config.test.ts` takes, for the same reason.
 */
const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:15432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const PEPPER = 'p'.repeat(48);
const HOUR_MS = 3_600_000;

describe('createRateLimitConfig', () => {
  it('refuses to build without RATE_LIMIT_KEY_SECRET, naming the variable', () => {
    const config = parseEnv(BASE_ENV);
    expect(config.rateLimit.keySecret).toBeUndefined();

    // The alternative to failing here is hashing unkeyed, which silently
    // downgrades the control that keeps phone numbers out of the Redis key
    // space. A startup that refuses is a deployment problem; one that boots
    // is a privacy incident nobody notices.
    expect(() => createRateLimitConfig(config)).toThrow(MissingRateLimitKeySecretError);
    try {
      createRateLimitConfig(config);
      throw new Error('expected createRateLimitConfig to throw');
    } catch (error) {
      expect((error as Error).message).toContain('RATE_LIMIT_KEY_SECRET');
    }
  });

  it('maps every configured budget onto its policy, with an hour-long window', () => {
    const config = createRateLimitConfig(
      parseEnv({
        ...BASE_ENV,
        RATE_LIMIT_KEY_SECRET: PEPPER,
        OTP_RATE_LIMIT_PER_PHONE_HOUR: '3',
        OTP_RATE_LIMIT_PER_IP_HOUR: '9',
        SIGNIN_RATE_LIMIT_PER_IDENTIFIER_HOUR: '7',
        SIGNIN_RATE_LIMIT_PER_IP_HOUR: '21',
        REFRESH_RATE_LIMIT_PER_SESSION_HOUR: '40',
        REFRESH_RATE_LIMIT_PER_IP_HOUR: '80',
        PRICE_RANGE_RATE_LIMIT_PER_USER_HOUR: '15',
        PRICE_RANGE_RATE_LIMIT_PER_IP_HOUR: '45',
      }),
    );

    // Every variable name ends in _HOUR, so the window must actually be an
    // hour: a knob that reads "3 per hour" while the code enforced it over
    // ten minutes is a lie an operator has no way to see.
    expect(config.policies['otp-request']).toMatchObject({
      perIdentifier: 3,
      perIp: 9,
      windowMs: HOUR_MS,
    });
    expect(config.policies['sign-in']).toMatchObject({ perIdentifier: 7, perIp: 21 });
    expect(config.policies.refresh).toMatchObject({ perIdentifier: 40, perIp: 80 });
    expect(config.policies['price-range']).toMatchObject({ perIdentifier: 15, perIp: 45 });
  });

  it('derives the backoff ceiling from the multiplier, and makes 1 mean no backoff', () => {
    const withBackoff = createRateLimitConfig(
      parseEnv({
        ...BASE_ENV,
        RATE_LIMIT_KEY_SECRET: PEPPER,
        AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER: '3',
      }),
    );
    expect(withBackoff.policies['otp-request'].backoffCeilingMs).toBe(HOUR_MS * 3);

    // `.env.example` documents 1 as "disables backoff", and the limiter's Lua
    // script only extends a window when the ceiling exceeds it — so the two
    // statements have to agree, and this is where they are checked against
    // each other.
    const withoutBackoff = createRateLimitConfig(
      parseEnv({
        ...BASE_ENV,
        RATE_LIMIT_KEY_SECRET: PEPPER,
        AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER: '1',
      }),
    );
    expect(withoutBackoff.policies['otp-request'].backoffCeilingMs).toBe(
      withoutBackoff.policies['otp-request'].windowMs,
    );
  });
});
