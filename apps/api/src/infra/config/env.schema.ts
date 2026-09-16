import { z } from 'zod';

import type { AppConfig } from './app-config.types';

/**
 * A signing secret shorter than this is worse than no secret at all — a short
 * HMAC key is brute-forceable. 32 characters is a floor, not the recommended
 * value: `.env.example` tells operators to generate 48 random bytes
 * (`openssl rand -base64 48`, ~64 base64 characters), which comfortably
 * clears this floor. 32 matches the common 256-bit minimum guidance for an
 * HMAC-SHA256 signing key regardless of how the random bytes happen to be
 * encoded.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/** A JWT TTL as NestJS/`ms`-style shorthand: `15m`, `30d`, `3600s`, … */
const DURATION_PATTERN = /^\d+(ms|s|m|h|d)$/;

/**
 * `.env.example` uses an empty string as the placeholder for "not configured
 * yet" (`S3_ENDPOINT=`, `SMS_API_KEY=`, …), and a real `.env` file produced by
 * copying it keeps that convention. Treat an empty string exactly like an
 * absent variable everywhere, so "unset" and "set to empty" behave
 * identically instead of empty silently failing a `.min()` check meant for a
 * genuinely provided value.
 */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value === '' ? undefined : value;
}

function optionalString(): z.ZodType<string | undefined> {
  return z.preprocess(emptyToUndefined, z.string().optional());
}

function optionalUrl(): z.ZodType<string | undefined> {
  return z.preprocess(
    emptyToUndefined,
    z
      .url({ error: (issue) => (issue.input === undefined ? undefined : 'must be a valid URL') })
      .optional(),
  );
}

/**
 * A TTL always has a value. Access 15 minutes / refresh 30 days is policy
 * fixed by `docs/architecture/authentication.md` § Token model, not something
 * a deployment is expected to choose; the variable exists so a test or a
 * staging environment can shorten it, and the default is what production runs.
 *
 * Deliberately NOT optional, unlike the two JWT secrets above: a missing
 * secret must stop the process, whereas a missing TTL has one right answer.
 */
function duration(defaultValue: string): z.ZodType<string> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(DURATION_PATTERN, 'must look like a duration such as "15m" or "30d"')
      .default(defaultValue),
  );
}

/**
 * A bare `z.url()` only asks whether `new URL()` accepts the string, so
 * `DATABASE_URL=redis://localhost:6379` passes it happily — the two connection
 * strings are interchangeable to that check, and a deploy that swaps them
 * boots clean and fails on the first query instead. Pin the scheme.
 */
function requiredUrl(protocol: RegExp, expected: string): z.ZodType<string> {
  return z.preprocess(
    emptyToUndefined,
    z.url({
      protocol,
      error: (issue) => (issue.input === undefined ? undefined : `must be a ${expected} URL`),
    }),
  );
}

const POSTGRES_PROTOCOL = /^postgres(ql)?$/;
const REDIS_PROTOCOL = /^rediss?$/;

function positiveInt(defaultValue: number): z.ZodType<number> {
  return z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));
}

function nonNegativeInt(defaultValue: number): z.ZodType<number> {
  return z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).default(defaultValue));
}

/**
 * The flat schema, keyed by the literal environment variable name so a
 * validation issue's `path` is exactly the name an operator needs to fix —
 * this is what lets the error message name the offending variable without
 * any extra bookkeeping.
 *
 * Deliberately **not** `.strict()`: the object handed to `parseEnv` is
 * `process.env` in production, which carries the whole OS environment (PATH,
 * HOME, CI-injected variables, …), none of which this schema — or the
 * EXPO_PUBLIC_ guard, which scans separately — has any business rejecting.
 */
export const rawEnvSchema = z
  .object({
    // --- Runtime ---------------------------------------------------------
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    API_PORT: positiveInt(3000),
    API_HOST: z.preprocess(emptyToUndefined, z.string().min(1).default('0.0.0.0')),
    CORS_ORIGINS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .default('')
        .transform((value): readonly string[] =>
          Object.freeze(
            value
              .split(',')
              .map((origin) => origin.trim())
              .filter((origin) => origin.length > 0),
          ),
        ),
    ),

    // --- Database (PostgreSQL + PostGIS) ----------------------------------
    DATABASE_URL: requiredUrl(POSTGRES_PROTOCOL, 'postgresql://'),
    DATABASE_POOL_MAX: positiveInt(10),

    // --- Redis -------------------------------------------------------------
    REDIS_URL: requiredUrl(REDIS_PROTOCOL, 'redis://'),

    // --- Authentication — required by EPIC 2 ------------------------------
    JWT_ACCESS_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(
          MIN_JWT_SECRET_LENGTH,
          `must be at least ${String(MIN_JWT_SECRET_LENGTH)} characters long`,
        )
        .optional(),
    ),
    JWT_REFRESH_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(
          MIN_JWT_SECRET_LENGTH,
          `must be at least ${String(MIN_JWT_SECRET_LENGTH)} characters long`,
        )
        .optional(),
    ),
    JWT_ACCESS_TTL: duration('15m'),
    JWT_REFRESH_TTL: duration('30d'),

    // --- Object storage — required by EPIC 5/6 ----------------------------
    S3_ENDPOINT: optionalUrl(),
    S3_REGION: optionalString(),
    S3_BUCKET: optionalString(),
    S3_ACCESS_KEY_ID: optionalString(),
    S3_SECRET_ACCESS_KEY: optionalString(),
    S3_PUBLIC_BASE_URL: optionalUrl(),

    // --- Maps & geocoding (ADR-0004) ---------------------------------------
    MAPS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['google']).default('google')),
    GOOGLE_MAPS_SERVER_API_KEY: optionalString(),
    GEOCODE_CACHE_TTL_DAYS: positiveInt(90),

    // --- SMS / OTP (ADR-0008) ------------------------------------------
    // Only 'stub' exists today (docs/product/... nothing sends a real SMS
    // yet). Extend this enum only when a real provider is actually wired up.
    SMS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['stub']).default('stub')),
    SMS_API_KEY: optionalString(),
    SMS_SENDER_ID: optionalString(),
    OTP_LENGTH: positiveInt(6),
    OTP_TTL_SECONDS: positiveInt(300),
    OTP_MAX_ATTEMPTS: positiveInt(5),
    OTP_RATE_LIMIT_PER_PHONE_HOUR: positiveInt(5),
    OTP_RATE_LIMIT_PER_IP_HOUR: positiveInt(20),

    // --- Dispatch (ADR-0009) ------------------------------------------------
    DISPATCH_INITIAL_RADIUS_M: positiveInt(3000),
    DISPATCH_MAX_RADIUS_M: positiveInt(10000),
    DISPATCH_RADIUS_STEP_SECONDS: positiveInt(30),
    DISPATCH_TOTAL_TIMEOUT_SECONDS: positiveInt(180),
    DISPATCH_MAX_MASTERS_PER_BROADCAST: positiveInt(20),
    MAX_ORDER_REDISPATCHES: nonNegativeInt(2),

    // --- Order lifecycle and commission ------------------------------------
    MAX_COMMISSION_DEBT_MINOR: nonNegativeInt(5000),
    DISPUTE_WINDOW_HOURS: positiveInt(72),

    // --- Push notifications — required by EPIC 10 --------------------------
    EXPO_ACCESS_TOKEN: optionalString(),

    // --- Observability -------------------------------------------------
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    ),
  })
  .superRefine((value, ctx) => {
    // .env.example's own instruction: "These MUST be different values."
    // A shared signing secret means a stolen access token can also forge a
    // refresh token (and vice versa) — the two token families stop being
    // independent.
    if (
      value.JWT_ACCESS_SECRET !== undefined &&
      value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must be a different value from JWT_ACCESS_SECRET',
      });
    }
  });

export type RawEnv = z.infer<typeof rawEnvSchema>;

/**
 * Builds the grouped, readonly {@link AppConfig} from an already-validated
 * flat env object. Never called with unvalidated input — `parseEnv` is the
 * only caller.
 */
export function toAppConfig(env: RawEnv): AppConfig {
  return Object.freeze({
    runtime: Object.freeze({
      nodeEnv: env.NODE_ENV,
      port: env.API_PORT,
      host: env.API_HOST,
      corsOrigins: env.CORS_ORIGINS,
    }),
    database: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    }),
    redis: Object.freeze({
      url: env.REDIS_URL,
    }),
    auth: Object.freeze({
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      jwtAccessTtl: env.JWT_ACCESS_TTL,
      jwtRefreshTtl: env.JWT_REFRESH_TTL,
    }),
    storage: Object.freeze({
      s3Endpoint: env.S3_ENDPOINT,
      s3Region: env.S3_REGION,
      s3Bucket: env.S3_BUCKET,
      s3AccessKeyId: env.S3_ACCESS_KEY_ID,
      s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
      s3PublicBaseUrl: env.S3_PUBLIC_BASE_URL,
    }),
    maps: Object.freeze({
      provider: env.MAPS_PROVIDER,
      serverApiKey: env.GOOGLE_MAPS_SERVER_API_KEY,
      geocodeCacheTtlDays: env.GEOCODE_CACHE_TTL_DAYS,
    }),
    sms: Object.freeze({
      provider: env.SMS_PROVIDER,
      apiKey: env.SMS_API_KEY,
      senderId: env.SMS_SENDER_ID,
      otp: Object.freeze({
        length: env.OTP_LENGTH,
        ttlSeconds: env.OTP_TTL_SECONDS,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        rateLimitPerPhoneHour: env.OTP_RATE_LIMIT_PER_PHONE_HOUR,
        rateLimitPerIpHour: env.OTP_RATE_LIMIT_PER_IP_HOUR,
      }),
    }),
    dispatch: Object.freeze({
      initialRadiusM: env.DISPATCH_INITIAL_RADIUS_M,
      maxRadiusM: env.DISPATCH_MAX_RADIUS_M,
      radiusStepSeconds: env.DISPATCH_RADIUS_STEP_SECONDS,
      totalTimeoutSeconds: env.DISPATCH_TOTAL_TIMEOUT_SECONDS,
      maxMastersPerBroadcast: env.DISPATCH_MAX_MASTERS_PER_BROADCAST,
      maxOrderRedispatches: env.MAX_ORDER_REDISPATCHES,
    }),
    orders: Object.freeze({
      maxCommissionDebtMinor: env.MAX_COMMISSION_DEBT_MINOR,
      disputeWindowHours: env.DISPUTE_WINDOW_HOURS,
    }),
    notifications: Object.freeze({
      expoAccessToken: env.EXPO_ACCESS_TOKEN,
    }),
    observability: Object.freeze({
      logLevel: env.LOG_LEVEL,
    }),
  });
}
