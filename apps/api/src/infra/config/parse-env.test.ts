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
    // Both providers default to their stub, so a fresh clone runs with no
    // billing account and no keys. Each stub refuses to construct under
    // NODE_ENV=production, so neither default can ship by accident.
    expect(config.maps.provider).toBe('stub');
    expect(config.sms.provider).toBe('stub');
    // Capped at 30 by Google's Maps Service Specific Terms §6.3.1, and the
    // default sits at the ceiling because a geocoded point does not go stale —
    // the licence is the only reason to expire it (ADR-0022).
    expect(config.maps.geocodeCacheTtlDays).toBe(30);
    expect(config.maps.geocodeLanguage).toBe('az');
    expect(config.maps.geocodeCountry).toBe('AZ');
    expect(config.sms.otp.length).toBe(6);
    expect(config.dispatch.initialRadiusM).toBe(3000);
    expect(config.orders.disputeWindowHours).toBe(72);
    // NODE_ENV-dependent since #129: VALID_ENV leaves NODE_ENV unset, so this
    // is the development default — what the process printed before the
    // variable did anything. `log-levels.test.ts` owns the rest.
    expect(config.observability.logLevel).toBe('debug');
    // The two Redis namespaces default to the same stable name in production
    // and are separate variables on purpose — #125.
    expect(config.queue.prefix).toBe('tezusta');
    expect(config.redis.keyPrefix).toBe('tezusta');

    // Never set, so still undefined rather than a fabricated value — these
    // are only required starting the Epics named in app-config.types.ts.
    expect(config.auth.jwtAccessSecret).toBeUndefined();
    expect(config.storage.s3Bucket).toBeUndefined();
    expect(config.notifications.expoAccessToken).toBeUndefined();
  });

  describe('REDIS_KEY_PREFIX (issue #125)', () => {
    it('is carried through, and is independent of QUEUE_PREFIX', () => {
      const config = parseEnv({
        ...VALID_ENV,
        REDIS_KEY_PREFIX: 'run-17',
        QUEUE_PREFIX: 'queue-17',
      });

      // Two knobs, not one alias for the other: renaming the queue namespace
      // strands delayed jobs, renaming this one costs a cold cache.
      expect(config.redis.keyPrefix).toBe('run-17');
      expect(config.queue.prefix).toBe('queue-17');
    });

    it('refuses a value that would reshape the key space instead of naming it', () => {
      // The value is concatenated into every key, so a colon silently invents
      // a segment and a brace changes the hash slot on a cluster. Both must
      // fail the boot rather than the keyspace.
      for (const bad of ['run:17', 'run{17}', 'run 17', '', 'x'.repeat(33)]) {
        const env = { ...VALID_ENV, REDIS_KEY_PREFIX: bad };
        if (bad === '') {
          // An empty string is "not configured" everywhere in this schema, so
          // it takes the default rather than failing.
          expect(parseEnv(env).redis.keyPrefix).toBe('tezusta');
          continue;
        }
        expect(() => parseEnv(env)).toThrow(EnvValidationError);
        expect(issueNaming(env, 'REDIS_KEY_PREFIX')).toMatch(/1-32 characters/);
      }
    });
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
      expect(config.rateLimit.priceRangePerUserHour).toBe(120);
      expect(config.rateLimit.priceRangePerIpHour).toBe(300);
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
      ['PRICE_RANGE_RATE_LIMIT_PER_USER_HOUR', '0'],
      ['PRICE_RANGE_RATE_LIMIT_PER_IP_HOUR', '0'],
      // **A licence ceiling, not a preference.** Google's Maps Service Specific
      // Terms §6.3.1 permit caching lat/lng for "up to 30 consecutive calendar
      // days" (ADR-0022). 90 was the value this repository shipped in
      // `.env.example` before anyone read the terms, which is exactly the
      // mistake an operator would repeat — and a cache that quietly breaches a
      // licence is the kind of defect no test would otherwise catch, because
      // the code looks correct.
      ['GEOCODE_CACHE_TTL_DAYS', '90'],
      ['GEOCODE_CACHE_TTL_DAYS', '31'],
      ['GEOCODE_CACHE_TTL_DAYS', '0'],
      ['GEOCODE_RATE_LIMIT_PER_USER_HOUR', '0'],
      ['GEOCODE_RATE_LIMIT_PER_IP_HOUR', '0'],
      // A geocode sits on the path of a customer saving an address; a
      // half-minute timeout is a spinner, not a lookup.
      ['GEOCODE_TIMEOUT_MS', '60000'],
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

    it('rejects an auth retention window shorter than the refresh token lifetime', () => {
      // The sweep (#57) deletes refresh tokens and sessions past this window.
      // Shorter than the family's own lifetime and it deletes LIVE
      // credentials — a maintenance job signing users out — and destroys the
      // spent rows reuse detection reads, so a replayed token hashes to
      // nothing and the theft signal is silently lost. Both values pass their
      // own range checks; only the comparison catches it.
      const env = { ...VALID_ENV, JWT_REFRESH_TTL: '30d', AUTH_RETENTION_DAYS: '29' };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'AUTH_RETENTION_DAYS')).toMatch(/JWT_REFRESH_TTL/);
    });

    it('accepts a retention window exactly equal to the refresh token lifetime', () => {
      const env = { ...VALID_ENV, JWT_REFRESH_TTL: '30d', AUTH_RETENTION_DAYS: '30' };

      expect(parseEnv(env).maintenance.authRetentionDays).toBe(30);
    });

    it('rejects an incident retention window shorter than the ordinary one', () => {
      // The theft record must outlive an ordinary expired session, never the
      // other way round — otherwise the longer window buys nothing.
      const env = { ...VALID_ENV, AUTH_RETENTION_DAYS: '45', AUTH_INCIDENT_RETENTION_DAYS: '44' };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      expect(issueNaming(env, 'AUTH_INCIDENT_RETENTION_DAYS')).toMatch(/AUTH_RETENTION_DAYS/);
    });

    it('ships the decided retention windows — 45 days ordinary, a year for a reuse incident', () => {
      // These two defaults are the policy, not tuning: ADR-0027 decided that a
      // `reuse_detected` family is kept whole for one year and then deleted,
      // and the value shipped is the whole of how that decision is expressed —
      // there is no incident table and no other enforcement point. An
      // unasserted default can be widened or narrowed by anyone editing the
      // schema for an unrelated reason, which is how a retention policy drifts
      // without a decision ever being revisited.
      const config = parseEnv(VALID_ENV);

      expect(config.maintenance.authRetentionDays).toBe(45);
      expect(config.maintenance.authIncidentRetentionDays).toBe(365);
    });

    it('treats a zero sweep interval as a supported value, not a range error', () => {
      // Zero is how the test suites and an externally-driven deployment say
      // "do not schedule"; it must not be rejected the way a zero TTL is.
      const env = { ...VALID_ENV, MAINTENANCE_SWEEP_INTERVAL_MINUTES: '0' };

      expect(parseEnv(env).maintenance.sweepIntervalMinutes).toBe(0);
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

  describe('calls (issue #184) — LiveKit selected and misconfigured stops the boot, not the first call', () => {
    const LIVEKIT_ENV = {
      ...VALID_ENV,
      CALLS_PROVIDER: 'livekit',
      LIVEKIT_URL: 'wss://calls.example.com',
      LIVEKIT_API_KEY: 'APIkey123',
      LIVEKIT_API_SECRET: 'l'.repeat(40),
    };

    it('defaults to the stub, with a ten-minute join token and no LiveKit values to leak', () => {
      const config = parseEnv(VALID_ENV);

      expect(config.calls).toEqual({
        provider: 'stub',
        joinTokenTtlSeconds: 600,
        signalling: {
          ringTimeoutSeconds: 30,
          invitesPerOrder: 6,
          inviteWindowSeconds: 600,
          reaperIntervalSeconds: 60,
          maxDurationMinutes: 240,
          ringPushEnabled: false,
        },
      });
    });

    it('carries a complete LiveKit configuration, deriving the API URL from the public one', () => {
      const config = parseEnv(LIVEKIT_ENV);

      expect(config.calls).toEqual({
        provider: 'livekit',
        joinTokenTtlSeconds: 600,
        signalling: {
          ringTimeoutSeconds: 30,
          invitesPerOrder: 6,
          inviteWindowSeconds: 600,
          reaperIntervalSeconds: 60,
          maxDurationMinutes: 240,
          ringPushEnabled: false,
        },
        livekit: {
          publicUrl: 'wss://calls.example.com',
          apiUrl: 'https://calls.example.com',
          apiKey: 'APIkey123',
          apiSecret: 'l'.repeat(40),
        },
      });
    });

    it('derives http:// from ws://, and prefers LIVEKIT_API_URL when it is set', () => {
      const local = parseEnv({ ...LIVEKIT_ENV, LIVEKIT_URL: 'ws://localhost:7880' });
      const split = parseEnv({ ...LIVEKIT_ENV, LIVEKIT_API_URL: 'http://livekit.internal:7880' });

      expect(local.calls.provider === 'livekit' && local.calls.livekit.apiUrl).toBe(
        'http://localhost:7880',
      );
      expect(split.calls.provider === 'livekit' && split.calls.livekit.apiUrl).toBe(
        'http://livekit.internal:7880',
      );
      expect(split.calls.provider === 'livekit' && split.calls.livekit.publicUrl).toBe(
        'wss://calls.example.com',
      );
    });

    it('names every missing connection value at once when LiveKit is selected', () => {
      const env = { ...VALID_ENV, CALLS_PROVIDER: 'livekit' };

      expect(() => parseEnv(env)).toThrow(EnvValidationError);
      for (const variable of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
        expect(issueNaming(env, variable)).toMatch(/required when CALLS_PROVIDER=livekit/);
      }
    });

    it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])(
      'treats an empty %s as missing, the way .env.example leaves unset values',
      (variable) => {
        const env = { ...LIVEKIT_ENV, [variable]: '' };

        expect(issueNaming(env, variable)).toMatch(/required when CALLS_PROVIDER=livekit/);
      },
    );

    it('does not ask for LiveKit values while the stub is selected', () => {
      expect(() => parseEnv({ ...VALID_ENV, CALLS_PROVIDER: 'stub' })).not.toThrow();
    });

    it('refuses a short secret, and the CHANGE_ME placeholder, as a signing secret', () => {
      const short = { ...LIVEKIT_ENV, LIVEKIT_API_SECRET: 'too-short' };
      const placeholder = {
        ...LIVEKIT_ENV,
        LIVEKIT_API_SECRET: 'CHANGE_ME_generate_a_48_byte_random_value',
      };

      expect(issueNaming(short, 'LIVEKIT_API_SECRET')).toMatch(/at least 32 characters/);
      expect(issueNaming(placeholder, 'LIVEKIT_API_SECRET')).toMatch(/placeholder/);
    });

    it('refuses a secret shared with any other signing secret', () => {
      const env = {
        ...LIVEKIT_ENV,
        JWT_ACCESS_SECRET: 'l'.repeat(40),
        JWT_REFRESH_SECRET: 'r'.repeat(40),
      };

      expect(issueNaming(env, 'LIVEKIT_API_SECRET')).toMatch(/different value/);
    });

    it.each([
      ['https://calls.example.com', 'a URL the client SDK cannot dial'],
      ['calls.example.com', 'no scheme at all'],
    ])('refuses LIVEKIT_URL=%s (%s)', (url) => {
      expect(issueNaming({ ...LIVEKIT_ENV, LIVEKIT_URL: url }, 'LIVEKIT_URL')).toMatch(
        /ws:\/\/ or wss:\/\//,
      );
    });

    it('refuses a plaintext ws:// URL in production — the token would travel in the clear', () => {
      const env = { ...LIVEKIT_ENV, NODE_ENV: 'production', LIVEKIT_URL: 'ws://calls.example.com' };

      expect(issueNaming(env, 'LIVEKIT_URL')).toMatch(/wss:\/\//);
    });

    it('refuses the development secret committed in docker-compose.yml, in production only', () => {
      const compose = readFileSync(
        path.join(__dirname, '../../../../../docker-compose.yml'),
        'utf8',
      );
      const devSecret = /LIVEKIT_KEYS: 'devkey: (\S+)'/.exec(compose)?.[1];
      expect(devSecret).toBeTruthy();

      const development = { ...LIVEKIT_ENV, LIVEKIT_API_SECRET: devSecret };
      const production = { ...development, NODE_ENV: 'production' };

      expect(() => parseEnv(development)).not.toThrow();
      expect(issueNaming(production, 'LIVEKIT_API_SECRET')).toMatch(/development secret/);
    });

    it('ships .env.example with the same development pair docker-compose.yml runs', () => {
      // So `CALLS_PROVIDER=livekit` against the local stack is one edit, and
      // so the production refusal above covers the value a copied template
      // would carry.
      const contents = readFileSync(path.join(__dirname, '../../../../../.env.example'), 'utf8');
      const compose = readFileSync(
        path.join(__dirname, '../../../../../docker-compose.yml'),
        'utf8',
      );

      const secret = /^LIVEKIT_API_SECRET=(.*)$/m.exec(contents)?.[1];
      const key = /^LIVEKIT_API_KEY=(.*)$/m.exec(contents)?.[1];
      expect(compose).toContain(`LIVEKIT_KEYS: '${String(key)}: ${String(secret)}'`);
    });

    it('bounds the join token lifetime between a minute and an hour', () => {
      expect(
        issueNaming(
          { ...VALID_ENV, CALL_JOIN_TOKEN_TTL_SECONDS: '59' },
          'CALL_JOIN_TOKEN_TTL_SECONDS',
        ),
      ).toMatch(/at least 60/);
      expect(
        issueNaming(
          { ...VALID_ENV, CALL_JOIN_TOKEN_TTL_SECONDS: '3601' },
          'CALL_JOIN_TOKEN_TTL_SECONDS',
        ),
      ).toMatch(/at most 3600/);
      expect(
        parseEnv({ ...VALID_ENV, CALL_JOIN_TOKEN_TTL_SECONDS: '120' }).calls.joinTokenTtlSeconds,
      ).toBe(120);
    });

    it('bounds the ring timeout to 10–120 seconds (issue #185)', () => {
      expect(
        issueNaming({ ...VALID_ENV, CALL_RING_TIMEOUT_SECONDS: '9' }, 'CALL_RING_TIMEOUT_SECONDS'),
      ).toMatch(/at least 10/);
      expect(
        issueNaming(
          { ...VALID_ENV, CALL_RING_TIMEOUT_SECONDS: '121' },
          'CALL_RING_TIMEOUT_SECONDS',
        ),
      ).toMatch(/at most 120/);
      expect(
        parseEnv({ ...VALID_ENV, CALL_RING_TIMEOUT_SECONDS: '45' }).calls.signalling
          .ringTimeoutSeconds,
      ).toBe(45);
    });

    /**
     * #189, ADR-0039 § 3: off unless somebody says so, and only in words the
     * schema knows — a typo refuses to boot rather than quietly silencing (or
     * enabling) every ring.
     */
    it('keeps the ring push off by default and reads it only as true or false', () => {
      const ringPush = (value: string | undefined): boolean =>
        parseEnv({ ...VALID_ENV, CALL_RING_PUSH_ENABLED: value }).calls.signalling.ringPushEnabled;

      expect(parseEnv(VALID_ENV).calls.signalling.ringPushEnabled).toBe(false);
      expect(ringPush('')).toBe(false);
      expect(ringPush('false')).toBe(false);
      expect(ringPush('true')).toBe(true);
      expect(
        issueNaming({ ...VALID_ENV, CALL_RING_PUSH_ENABLED: 'yes' }, 'CALL_RING_PUSH_ENABLED'),
      ).toBeDefined();
    });

    it('bounds the call reaper interval and the answered-call cap (issue #186)', () => {
      expect(
        issueNaming(
          { ...VALID_ENV, CALL_REAPER_INTERVAL_SECONDS: '601' },
          'CALL_REAPER_INTERVAL_SECONDS',
        ),
      ).toMatch(/at most 600/);
      expect(
        parseEnv({ ...VALID_ENV, CALL_REAPER_INTERVAL_SECONDS: '0' }).calls.signalling
          .reaperIntervalSeconds,
      ).toBe(0);
      expect(
        issueNaming({ ...VALID_ENV, CALL_MAX_DURATION_MINUTES: '29' }, 'CALL_MAX_DURATION_MINUTES'),
      ).toMatch(/at least 30/);
      expect(
        issueNaming(
          { ...VALID_ENV, CALL_MAX_DURATION_MINUTES: '721' },
          'CALL_MAX_DURATION_MINUTES',
        ),
      ).toMatch(/at most 720/);
    });

    it('never puts the secret in the error it throws', () => {
      const secret = `CHANGE_ME_${'s'.repeat(40)}`;
      try {
        parseEnv({ ...LIVEKIT_ENV, LIVEKIT_API_SECRET: secret, LIVEKIT_URL: 'nope' });
        throw new Error('expected parseEnv to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        expect((error as Error).message).toContain('LIVEKIT_API_SECRET');
        expect((error as Error).message).not.toContain(secret);
      }
    });
  });
});
