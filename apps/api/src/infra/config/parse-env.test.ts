import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './parse-env';

/**
 * A minimal, fully valid environment: every required variable set, every
 * defaulted variable left absent so the assertions below can prove the
 * defaults actually apply.
 */
const VALID_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('parses a valid environment and the typed result carries the expected values, including applied defaults', () => {
    const config = parseEnv(VALID_ENV);

    expect(config.database.url).toBe(VALID_ENV.DATABASE_URL);
    expect(config.redis.url).toBe(VALID_ENV.REDIS_URL);

    // Defaults, since VALID_ENV never set these.
    expect(config.runtime.nodeEnv).toBe('development');
    expect(config.runtime.port).toBe(3000);
    expect(config.runtime.host).toBe('0.0.0.0');
    expect(config.database.poolMax).toBe(10);
    expect(config.maps.provider).toBe('google');
    expect(config.sms.provider).toBe('stub');
    expect(config.sms.otp.length).toBe(6);
    expect(config.dispatch.initialRadiusM).toBe(3000);
    expect(config.orders.disputeWindowHours).toBe(72);
    expect(config.observability.logLevel).toBe('info');

    // Never set, so still undefined rather than a fabricated value — these
    // are only required starting the Epics named in app-config.types.ts.
    expect(config.auth.jwtAccessSecret).toBeUndefined();
    expect(config.storage.s3Bucket).toBeUndefined();
    expect(config.notifications.expoAccessToken).toBeUndefined();
  });

  it('splits CORS_ORIGINS on commas, trims whitespace, and drops empty entries', () => {
    const config = parseEnv({
      ...VALID_ENV,
      CORS_ORIGINS: 'https://a.example.com, https://b.example.com ,,  ',
    });

    expect(config.runtime.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('defaults CORS_ORIGINS to an empty list when unset', () => {
    const config = parseEnv(VALID_ENV);

    expect(config.runtime.corsOrigins).toEqual([]);
  });

  it('coerces numeric variables and applies a non-default value when one is provided', () => {
    const config = parseEnv({ ...VALID_ENV, API_PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(config.runtime.port).toBe(8080);
    expect(config.database.poolMax).toBe(25);
  });

  it('accepts a JWT secret at or above the minimum length', () => {
    const secret = 'a'.repeat(32);
    const otherSecret = 'b'.repeat(32);

    const config = parseEnv({
      ...VALID_ENV,
      JWT_ACCESS_SECRET: secret,
      JWT_REFRESH_SECRET: otherSecret,
    });

    expect(config.auth.jwtAccessSecret).toBe(secret);
    expect(config.auth.jwtRefreshSecret).toBe(otherSecret);
  });

  it('throws when a required variable is missing', () => {
    const { DATABASE_URL: _omit, ...withoutDatabaseUrl } = VALID_ENV;

    expect(() => parseEnv(withoutDatabaseUrl)).toThrow(EnvValidationError);
    try {
      parseEnv(withoutDatabaseUrl);
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(
        (error as EnvValidationError).issues.some((issue) => issue.includes('DATABASE_URL')),
      ).toBe(true);
    }
  });

  it('throws when a value is malformed: non-numeric API_PORT', () => {
    try {
      parseEnv({ ...VALID_ENV, API_PORT: 'not-a-number' });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.some((issue) => issue.includes('API_PORT'))).toBe(
        true,
      );
    }
  });

  it('throws when a value is malformed: non-URL DATABASE_URL', () => {
    try {
      parseEnv({ ...VALID_ENV, DATABASE_URL: 'not-a-url-at-all' });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.issues.some((issue) => issue.includes('DATABASE_URL'))).toBe(true);
      expect(err.issues.some((issue) => issue.toLowerCase().includes('url'))).toBe(true);
    }
  });

  it('lists every offending variable at once, not just the first', () => {
    try {
      parseEnv({
        DATABASE_URL: 'not-a-url-at-all',
        REDIS_URL: 'also-not-a-url',
        API_PORT: 'not-a-number',
        NODE_ENV: 'staging', // not one of the allowed enum values
      });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;

      expect(issues.some((issue) => issue.includes('DATABASE_URL'))).toBe(true);
      expect(issues.some((issue) => issue.includes('REDIS_URL'))).toBe(true);
      expect(issues.some((issue) => issue.includes('API_PORT'))).toBe(true);
      expect(issues.some((issue) => issue.includes('NODE_ENV'))).toBe(true);
      expect(issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('requires JWT_ACCESS_SECRET and JWT_REFRESH_SECRET to differ when both are set', () => {
    const sharedSecret = 'c'.repeat(32);

    expect(() =>
      parseEnv({ ...VALID_ENV, JWT_ACCESS_SECRET: sharedSecret, JWT_REFRESH_SECRET: sharedSecret }),
    ).toThrow(EnvValidationError);
  });

  it('never includes a submitted secret value in the thrown error message, even when the fault is a malformed value carrying one', () => {
    const secretValue = 'SuperSecretPassword123';

    try {
      parseEnv({
        ...VALID_ENV,
        // Deliberately malformed (fails the URL check) while still carrying
        // the secret substring, so this proves the message-building path
        // never echoes the raw input.
        DATABASE_URL: `${secretValue} is not a url`,
        JWT_ACCESS_SECRET: 'too-short',
      });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;

      expect(err.message).not.toContain(secretValue);
      expect(err.message).not.toContain('too-short');
      for (const issue of err.issues) {
        expect(issue).not.toContain(secretValue);
        expect(issue).not.toContain('too-short');
      }
    }
  });

  it('rejects a secret smuggled behind EXPO_PUBLIC_, naming only the variable', () => {
    try {
      parseEnv({ ...VALID_ENV, EXPO_PUBLIC_JWT_ACCESS_SECRET: 'x'.repeat(40) });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const err = error as EnvValidationError;
      expect(err.issues.some((issue) => issue.includes('EXPO_PUBLIC_JWT_ACCESS_SECRET'))).toBe(
        true,
      );
      expect(err.message).not.toContain('x'.repeat(40));
    }
  });

  it('rejects EXPO_PUBLIC_DATABASE_URL and EXPO_PUBLIC_GOOGLE_MAPS_SERVER_API_KEY-style smuggled secrets', () => {
    try {
      parseEnv({
        ...VALID_ENV,
        EXPO_PUBLIC_DATABASE_URL: 'postgresql://leak',
        EXPO_PUBLIC_GOOGLE_MAPS_SERVER_API_KEY: 'leak',
      });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      const err = error as EnvValidationError;
      expect(err.issues.some((issue) => issue.includes('EXPO_PUBLIC_DATABASE_URL'))).toBe(true);
      expect(
        err.issues.some((issue) => issue.includes('EXPO_PUBLIC_GOOGLE_MAPS_SERVER_API_KEY')),
      ).toBe(true);
    }
  });

  it('accepts the two documented EXPO_PUBLIC_ map-key exceptions', () => {
    const config = parseEnv({
      ...VALID_ENV,
      EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY: 'android-key',
      EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY: 'ios-key',
    });

    // These are mobile-bundle variables, not part of the API's own config —
    // the assertion here is simply that parsing succeeds instead of throwing.
    expect(config.database.url).toBe(VALID_ENV.DATABASE_URL);
  });

  it('rejects a DATABASE_URL and REDIS_URL whose schemes have been swapped', () => {
    // The realistic deploy mistake: both values are well-formed URLs, so a
    // bare `new URL()` check passes and the process boots, then fails on the
    // first query. The scheme is what distinguishes them.
    try {
      parseEnv({
        DATABASE_URL: 'redis://localhost:6379',
        REDIS_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
      });
      expect.unreachable('swapped connection strings must not parse');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues).toContain('DATABASE_URL must be a postgresql:// URL');
      expect(issues).toContain('REDIS_URL must be a redis:// URL');
    }
  });

  it('accepts the postgres:// short form and a rediss:// TLS Redis URL', () => {
    const config = parseEnv({
      DATABASE_URL: 'postgres://tezusta:tezusta@localhost:5432/tezusta',
      REDIS_URL: 'rediss://cache.example.com:6379',
    });

    expect(config.database.url).toBe('postgres://tezusta:tezusta@localhost:5432/tezusta');
    expect(config.redis.url).toBe('rediss://cache.example.com:6379');
  });
});
