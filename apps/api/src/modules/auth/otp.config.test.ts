import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '../../infra/config/parse-env';
import { createOtpConfig, MissingOtpCodePepperError } from './otp.config';

/**
 * Minimal environment `parseEnv` accepts, with no OTP pepper —
 * `AppConfig.sms.otp.codePepper` is typed `string | undefined` for exactly the
 * reason `app-config.types.ts` gives. Built through the real `parseEnv` rather
 * than a hand-written `AppConfig` literal so these assertions cannot drift
 * from the schema they are about (the same approach `auth.config.test.ts`
 * takes).
 */
const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:15432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const PEPPER = 'p'.repeat(32);

describe('createOtpConfig', () => {
  it('refuses to build a configuration without OTP_CODE_PEPPER, naming the variable', () => {
    const config = parseEnv(BASE_ENV);
    expect(config.sms.otp.codePepper).toBeUndefined();

    try {
      createOtpConfig(config);
      throw new Error('expected createOtpConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingOtpCodePepperError);
      // The operator has to be told which variable to set. A generic
      // "configuration error" here is a deploy somebody debugs by reading
      // source.
      expect((error as MissingOtpCodePepperError).message).toContain('OTP_CODE_PEPPER');
    }
  });

  it('converts the TTL to milliseconds and carries the policy numbers through', () => {
    const config = parseEnv({ ...BASE_ENV, OTP_CODE_PEPPER: PEPPER });

    const otp = createOtpConfig(config);

    expect(otp).toEqual({
      codePepper: PEPPER,
      length: 6,
      // 300 seconds — ADR-0008's five-minute ceiling, as milliseconds because
      // that is the unit every `Date` calculation in the service uses.
      ttlMs: 300_000,
      maxAttempts: 5,
    });
  });
});

/**
 * These belong here rather than in `parse-env.test.ts` because they are about
 * the OTP policy specifically: the bounds exist so that a value which would
 * quietly weaken ADR-0008's guarantees stops the deploy instead.
 */
describe('the OTP policy variables are range-checked, not merely positive', () => {
  it('rejects a TTL longer than the five minutes ADR-0008 fixes', () => {
    // The concrete failure: `OTP_TTL_SECONDS=86400` is a positive integer and
    // would leave a six-digit code redeemable for a day.
    expect(() => parseEnv({ ...BASE_ENV, OTP_TTL_SECONDS: '86400' })).toThrow(EnvValidationError);
  });

  it('rejects a TTL so short that every code expires before the SMS lands', () => {
    expect(() => parseEnv({ ...BASE_ENV, OTP_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...BASE_ENV, OTP_TTL_SECONDS: '5' })).toThrow(EnvValidationError);
  });

  it('rejects a code shorter than the six digits ADR-0008 requires', () => {
    expect(() => parseEnv({ ...BASE_ENV, OTP_LENGTH: '4' })).toThrow(EnvValidationError);
  });

  it('names the offending variable when it refuses', () => {
    try {
      parseEnv({ ...BASE_ENV, OTP_TTL_SECONDS: '86400' });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).message).toContain('OTP_TTL_SECONDS');
    }
  });
});

describe('the OTP pepper is a secret of its own', () => {
  it('rejects a pepper that is also a JWT secret', () => {
    // Sharing it would mean the pepper cannot be rotated when a database dump
    // is suspected without signing every user out — so in practice it never
    // would be.
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        JWT_ACCESS_SECRET: PEPPER,
        JWT_REFRESH_SECRET: 'r'.repeat(32),
        OTP_CODE_PEPPER: PEPPER,
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects the .env.example placeholder, which is published in this repository', () => {
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        OTP_CODE_PEPPER: 'CHANGE_ME_generate_yet_another_48_byte_random_value',
      }),
    ).toThrow(EnvValidationError);
  });
});
