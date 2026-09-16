import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './parse-env';

/**
 * The human-readable strings an operator actually reads, from the thrown
 * {@link EnvValidationError}.
 *
 * These assert against that text rather than the raw Zod issue, because naming
 * the offending variable IS the feature: a boot failure that says "is still the
 * .env.example placeholder" without saying which variable leaves the operator
 * no better off than a silent one. `describeIssue`'s `'custom'` branch prefixes
 * the variable exactly like every other branch, and every custom message in
 * `env.schema.ts` is written as a bare predicate so that prefix reads as one
 * sentence.
 */
function issuesFrom(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseEnv(env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

function issueNaming(
  env: Record<string, string | undefined>,
  variable: string,
): string | undefined {
  return issuesFrom(env).find((issue) => issue.startsWith(`${variable} `));
}

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

  describe('regression: a .env.example placeholder secret must never validate (it published the exact string that would boot)', () => {
    it.each([
      ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'],
      ['JWT_REFRESH_SECRET', 'JWT_ACCESS_SECRET'],
    ] as const)(
      'rejects %s when it is still the CHANGE_ME placeholder',
      (placeholderVar, otherVar) => {
        const env = {
          ...VALID_ENV,
          [placeholderVar]: 'CHANGE_ME_generate_a_48_byte_random_value',
          [otherVar]: 'd'.repeat(32),
        };

        expect(() => parseEnv(env)).toThrow(EnvValidationError);
        // The message must name the variable, or the operator is told a
        // placeholder is in use without being told which one.
        expect(issueNaming(env, placeholderVar)).toMatch(/placeholder/);
      },
    );
  });

  describe('regression: JWT_ACCESS_TTL and JWT_REFRESH_TTL must fall within their documented ranges, not merely look like a duration', () => {
    it.each([
      ['0s — floors exp to iat, so every issued token is already expired', '0s'],
      ['2h — exceeds the 1-hour ceiling on an access token', '2h'],
    ])('rejects JWT_ACCESS_TTL=%s', (_label, value) => {
      const env = { ...VALID_ENV, JWT_ACCESS_TTL: value };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'JWT_ACCESS_TTL')).toMatch(/must be between/);
    });

    it.each([
      ['99999d — a credential nobody re-proves for centuries', '99999d'],
      ['30m — shorter than an hour makes signing in pointless', '30m'],
    ])('rejects JWT_REFRESH_TTL=%s', (_label, value) => {
      const env = { ...VALID_ENV, JWT_REFRESH_TTL: value };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'JWT_REFRESH_TTL')).toMatch(/must be between/);
    });

    it.each(['not-a-duration', '15', 'm', '1.5h', '2 days'])(
      'reports a malformed JWT_ACCESS_TTL (%s) as an EnvValidationError, not a raw parser throw',
      (value) => {
        // Zod v4 runs every check on a field even after an earlier one fails,
        // so the range refinement below the regex still receives a string the
        // duration grammar rejects. `safeParse` does not catch an exception
        // thrown from inside a refine callback, so an unguarded
        // `parseDurationMs` there would escape the whole EnvValidationError
        // path and hand the operator a raw stack trace instead of a named
        // variable.
        const env = { ...VALID_ENV, JWT_ACCESS_TTL: value };

        expect(() => parseEnv(env)).toThrow(EnvValidationError);
        expect(issueNaming(env, 'JWT_ACCESS_TTL')).toBeDefined();
      },
    );

    it('accepts the documented defaults (15m access, 30d refresh) and one other in-range value for each', () => {
      const config = parseEnv({
        ...VALID_ENV,
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL: '30d',
      });
      expect(config.auth.jwtAccessTtl).toBe('15m');
      expect(config.auth.jwtRefreshTtl).toBe('30d');

      const other = parseEnv({
        ...VALID_ENV,
        JWT_ACCESS_TTL: '45m', // within the 1-minute-to-1-hour access window
        JWT_REFRESH_TTL: '7d', // within the 1-hour-to-90-day refresh window
      });
      expect(other.auth.jwtAccessTtl).toBe('45m');
      expect(other.auth.jwtRefreshTtl).toBe('7d');
    });
  });

  describe('authentication rate limiting (issue #28) — a limit is only a limit if its value is bounded', () => {
    it('applies the documented defaults when nothing is set', () => {
      const config = parseEnv(VALID_ENV);

      expect(config.rateLimit.signInPerIdentifierHour).toBe(10);
      expect(config.rateLimit.signInPerIpHour).toBe(30);
      expect(config.rateLimit.refreshPerSessionHour).toBe(60);
      expect(config.rateLimit.refreshPerIpHour).toBe(120);
      expect(config.rateLimit.backoffMultiplier).toBe(4);
      // Optional, and `RateLimitModule` is what refuses to start without it.
      expect(config.rateLimit.keySecret).toBeUndefined();
    });

    it.each([
      // Zero disables the control entirely while looking like a configured
      // value — the class docs/engineering/security.md § Environment
      // validation names with OTP_TTL_SECONDS=0.
      ['OTP_RATE_LIMIT_PER_PHONE_HOUR', '0'],
      // An extra zero turns a financial control into no control at all, and
      // nothing in the logs would say so.
      ['OTP_RATE_LIMIT_PER_PHONE_HOUR', '50000'],
      ['OTP_MAX_ATTEMPTS', '0'],
      // A six-digit code with a thousand guesses is not capped.
      ['OTP_MAX_ATTEMPTS', '1000'],
      ['SIGNIN_RATE_LIMIT_PER_IDENTIFIER_HOUR', '0'],
      ['SIGNIN_RATE_LIMIT_PER_IP_HOUR', '0'],
      ['REFRESH_RATE_LIMIT_PER_SESSION_HOUR', '0'],
      ['REFRESH_RATE_LIMIT_PER_IP_HOUR', '0'],
      // 0 would make the backoff ceiling smaller than the window itself.
      ['AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER', '0'],
    ] as const)('rejects %s=%s, naming the variable', (variable, value) => {
      const env = { ...VALID_ENV, [variable]: value };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, variable)).toBeDefined();
    });

    it('rejects a rate-limit pepper that is one of the JWT signing secrets', () => {
      const shared = 'e'.repeat(40);
      const env = {
        ...VALID_ENV,
        JWT_ACCESS_SECRET: shared,
        JWT_REFRESH_SECRET: 'f'.repeat(40),
        RATE_LIMIT_KEY_SECRET: shared,
      };

      // The pepper is fed attacker-chosen input (a phone number the caller
      // supplies) through HMAC. That is not a position to put a token-signing
      // key in, and a secret shared by two subsystems is one that never gets
      // rotated for either.
      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'RATE_LIMIT_KEY_SECRET')).toMatch(/different value/);
    });
  });

  describe('regression: the shipped .env.example must itself fail validation for the two signing secrets', () => {
    // This is the actual failure scenario the CHANGE_ME check exists for:
    // someone copies the template to `.env` and never edits it. Reading the
    // real file (rather than a copy of its contents pasted into this test)
    // is what keeps the template and the schema honest with each other — if
    // either one drifts, this test is the one that notices.
    it('rejects the placeholder JWT_ACCESS_SECRET and JWT_REFRESH_SECRET values shipped in .env.example', () => {
      const envExamplePath = path.join(__dirname, '../../../../../.env.example');
      const contents = readFileSync(envExamplePath, 'utf8');

      const accessSecret = /^JWT_ACCESS_SECRET=(.*)$/m.exec(contents)?.[1];
      const refreshSecret = /^JWT_REFRESH_SECRET=(.*)$/m.exec(contents)?.[1];
      expect(accessSecret).toBeTruthy();
      expect(refreshSecret).toBeTruthy();
      // Confirms this test is actually exercising the placeholder, not an
      // already-edited template that would make the assertions below pass
      // for the wrong reason.
      expect(accessSecret).toMatch(/^CHANGE_ME/);
      expect(refreshSecret).toMatch(/^CHANGE_ME/);

      const env = {
        ...VALID_ENV,
        JWT_ACCESS_SECRET: accessSecret,
        JWT_REFRESH_SECRET: refreshSecret,
      };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      // Both are reported, each naming itself — the operator must not have to
      // fix one, reboot, and discover the other.
      expect(issueNaming(env, 'JWT_ACCESS_SECRET')).toMatch(/placeholder/);
      expect(issueNaming(env, 'JWT_REFRESH_SECRET')).toMatch(/placeholder/);
    });

    it('rejects the placeholder RATE_LIMIT_KEY_SECRET shipped in .env.example', () => {
      const envExamplePath = path.join(__dirname, '../../../../../.env.example');
      const contents = readFileSync(envExamplePath, 'utf8');

      const pepper = /^RATE_LIMIT_KEY_SECRET=(.*)$/m.exec(contents)?.[1];
      expect(pepper).toBeTruthy();
      expect(pepper).toMatch(/^CHANGE_ME/);

      // Same failure as the two secrets above, third variable: a template
      // copied to `.env` and never edited would otherwise hash every phone
      // number under a pepper published in this repository — which is a bare
      // hash with extra steps, and reversible in seconds over the +994
      // keyspace.
      const env = { ...VALID_ENV, RATE_LIMIT_KEY_SECRET: pepper };
      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'RATE_LIMIT_KEY_SECRET')).toMatch(/placeholder/);
    });
  });
});
