import { z } from 'zod';

import { parseDurationMs } from '../../common/time/parse-duration';
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
function duration(defaultValue: string, minMs: number, maxMs: number): z.ZodType<string> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(DURATION_PATTERN, 'must look like a duration such as "15m" or "30d"')
      .refine(
        (value) => {
          // Zod v4 runs every check on a field regardless of whether an
          // earlier one failed, so this callback still sees a value the
          // `.regex()` above already rejected — and `parseDurationMs` throws
          // on that, from inside a refine, where `safeParse` does NOT catch
          // it. The whole EnvValidationError path would be bypassed and the
          // operator would get a raw stack trace instead of a named variable.
          // Deferring to the regex issue (rather than adding a second one for
          // the same fault) keeps the reported problem singular and true.
          if (!DURATION_PATTERN.test(value)) {
            return true;
          }
          const ms = parseDurationMs(value);
          return ms >= minMs && ms <= maxMs;
        },
        // Range, not just shape: `0s` matches the pattern and is catastrophic.
        // An access TTL of zero floors to `exp === iat`, and verification
        // rejects on `now >= exp`, so EVERY token the service issues is
        // already expired — a total authentication outage produced by a
        // perfectly well-formed value. `docs/engineering/security.md`
        // § Environment validation names this class directly: "validate
        // ranges, not just presence".
        `must be between ${formatMs(minMs)} and ${formatMs(maxMs)}`,
      )
      .default(defaultValue),
  );
}

/** Human-readable bound for the message above. Never parsed back. */
function formatMs(ms: number): string {
  if (ms % 86_400_000 === 0) {
    return `${String(ms / 86_400_000)}d`;
  }
  if (ms % 3_600_000 === 0) {
    return `${String(ms / 3_600_000)}h`;
  }
  return `${String(ms / 60_000)}m`;
}

/**
 * `.env.example` ships `CHANGE_ME_generate_a_48_byte_random_value` for each
 * signing secret. Those placeholders are long enough to clear the length
 * floor, and different enough from each other to clear the "must differ"
 * refinement — so a `.env` copied from the template and never edited boots a
 * perfectly healthy API whose HMAC key is a string published in this
 * repository. Anyone could then mint a token for any user id with any role.
 *
 * Presence was never the property that mattered; usability as a secret is.
 * Rejected in every environment rather than only in production: an
 * authentication system that behaves differently in development is one whose
 * development behaviour is what gets tested.
 */
const PLACEHOLDER_SECRET = /^CHANGE_ME/;

function signingSecret(): z.ZodType<string | undefined> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string()
      .min(
        MIN_JWT_SECRET_LENGTH,
        `must be at least ${String(MIN_JWT_SECRET_LENGTH)} characters long`,
      )
      .refine(
        (value) => !PLACEHOLDER_SECRET.test(value),
        'is still the .env.example placeholder — generate a real value with `openssl rand -base64 48`',
      )
      .optional(),
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
 * An integer with a **ceiling as well as a floor**, for the values where an
 * absurd-but-positive number disables the thing it configures rather than
 * merely tuning it.
 *
 * `positiveInt` is the right tool for a pool size or a radius, where "very
 * large" is a bad idea an operator finds out about. It is the wrong tool for
 * a rate limit: `OTP_RATE_LIMIT_PER_PHONE_HOUR=1000000` passes every shape
 * check, boots cleanly, reports nothing, and leaves the endpoint ADR-0008
 * calls a **financial** control completely unthrottled. The same typo in the
 * other direction (`0`) is the case `docs/engineering/security.md`
 * § Environment validation names outright — "validate ranges, not just
 * presence", with `OTP_TTL_SECONDS=0` as its example — and it locks every
 * user out instead.
 *
 * Neither failure announces itself, which is what makes the bound worth
 * having: the deploy stops with the variable's name in the message.
 */
function boundedInt(defaultValue: number, min: number, max: number): z.ZodType<number> {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(min).max(max).default(defaultValue),
  );
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
    JWT_ACCESS_SECRET: signingSecret(),
    JWT_REFRESH_SECRET: signingSecret(),
    // Below a minute the token expires faster than a client can use it; above
    // an hour it stops bounding the damage from a stolen one, which is the
    // only reason it is short (authentication.md § Why a short access token).
    JWT_ACCESS_TTL: duration('15m', 60_000, 3_600_000),
    // A refresh family shorter than an hour makes sign-in pointless; longer
    // than 90 days is a credential nobody re-proves for a quarter of a year.
    JWT_REFRESH_TTL: duration('30d', 3_600_000, 90 * 86_400_000),
    // How long after a refresh token is spent a SECOND presentation of it is
    // still read as the same client retrying, rather than as theft.
    //
    // Not a loosening of reuse detection — it is what stops a flaky mobile
    // network from triggering it. A client that fires a refresh, loses the
    // response and retries has presented one token twice through nobody's
    // fault; with no window, that self-inflicts a sign-out across every device
    // the user owns. Bounded tightly at both ends: 0 disables the retry path
    // and makes a dropped response a logout, and anything long enough to be
    // useful to an attacker replaying a captured token is too long.
    REFRESH_REUSE_GRACE_SECONDS: boundedInt(10, 0, 60),

    // --- Admin authentication (ADR-0014) ----------------------------------
    // Its own signing secret. The consumer and admin token families share no
    // issuer, no audience and no key: a bug in either verifier is then still
    // not a crossover, and the admin key can be rotated without signing every
    // customer out.
    JWT_ADMIN_ACCESS_SECRET: signingSecret(),
    ADMIN_ACCESS_TTL: duration('15m', 60_000, 3_600_000),
    // ADR-0014: an admin session family lives 8 hours, against the consumer
    // path's 30 days. An admin credential is worth far more, so it is re-proved
    // far more often.
    ADMIN_SESSION_TTL: duration('8h', 3_600_000, 24 * 3_600_000),
    // The idle timeout, which the consumer path does not have at all. An admin
    // console left open on an unattended laptop is a different risk from a
    // phone in a pocket. Bounded below at a minute so a typo cannot lock every
    // admin out of a tool nobody else can fix.
    ADMIN_SESSION_IDLE_TIMEOUT: duration('30m', 60_000, 8 * 3_600_000),

    // --- Object storage (ADR-0005, ADR-0024) — required by EPIC 5/6 -------
    // Defaults to `stub` for the same reason `MAPS_PROVIDER` and
    // `SMS_PROVIDER` do: a clone of this repository runs, and its tests pass,
    // with no storage account. The stub refuses to construct under
    // NODE_ENV=production, so the default cannot quietly ship.
    STORAGE_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['s3', 'stub']).default('stub')),
    S3_ENDPOINT: optionalUrl(),
    S3_REGION: optionalString(),
    S3_BUCKET: optionalString(),
    S3_ACCESS_KEY_ID: optionalString(),
    S3_SECRET_ACCESS_KEY: optionalString(),
    S3_PUBLIC_BASE_URL: optionalUrl(),
    /**
     * **Capped at five minutes by ADR-0005**, not by taste: "presigned URLs
     * are short-lived (≤ 5 minutes) and single-use", because the window is
     * the whole exposure of a leaked URL. The floor is the other failure — a
     * TTL shorter than the time a photo takes to upload over a Baku mobile
     * connection means every upload expires in flight.
     */
    UPLOAD_PRESIGN_TTL_SECONDS: boundedInt(300, 30, 300),
    /**
     * Reads are separate and shorter. A download URL for an identity document
     * is handed to one viewer for one look; there is no upload to wait out, so
     * the only thing a longer window buys is a longer-lived bearer token for
     * somebody's ID card.
     */
    UPLOAD_DOWNLOAD_TTL_SECONDS: boundedInt(120, 30, 300),
    /**
     * The hard size cap on one verification document, in bytes.
     *
     * Five megabytes comfortably holds a phone photograph of an ID card and
     * stops well short of anything that is not one. **Enforced at confirm
     * rather than in the signature** — Cloudflare R2 does not implement the
     * S3 POST form-policy that would bind `content-length-range` into it
     * (ADR-0024), so an object over this size is refused, deleted, and never
     * becomes attachable.
     *
     * Bounded at both ends: a cap below 64 KiB rejects every real photograph,
     * and one above 20 MiB stops being a cap on a storage bill.
     */
    VERIFICATION_DOCUMENT_MAX_BYTES: boundedInt(5 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    /**
     * Presigned upload URLs a single master may mint per hour.
     *
     * Every one of them is permission to write bytes into a bucket somebody
     * pays for, which is `geocode`'s shape of abuse rather than `sign-in`'s.
     * Thirty leaves generous room for three documents and a master who
     * re-photographs a badly-lit ID card several times; it does not leave room
     * for a loop.
     */
    UPLOAD_PRESIGN_RATE_LIMIT_PER_USER_HOUR: boundedInt(30, 1, 10_000),
    UPLOAD_PRESIGN_RATE_LIMIT_PER_IP_HOUR: boundedInt(60, 1, 10_000),
    /**
     * The hard size cap on one order problem photo, in bytes (issue #83).
     *
     * A separate knob from `VERIFICATION_DOCUMENT_MAX_BYTES` rather than a
     * reuse of it: the two happen to share a default today, but a problem
     * photo and an identity document are different product surfaces, and
     * freezing them onto one variable would mean nobody could raise one cap
     * without raising the other. Same enforcement point either way —
     * checked at confirm against `head()`, never in the presigned URL's
     * signature (ADR-0024) — and the same bounds, for the same reason: below
     * 64 KiB rejects every real photograph, above 20 MiB stops being a cap.
     */
    ORDER_PHOTO_MAX_BYTES: boundedInt(5 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),

    // --- Orders (EPIC 6) ---------------------------------------------------
    /**
     * Orders one customer may create per hour.
     *
     * The abuse this bounds is not a bill — it is dispatch. Every created
     * order broadcasts to nearby masters (ADR-0009), so a loop here rings
     * real phones belonging to real people, and the masters would stop
     * trusting the notification long before anyone noticed the cause.
     *
     * Twenty is far above any plausible household: a customer with a burst
     * pipe, a stuck lock and a dead boiler in one evening is at three. It is
     * deliberately not tight enough to argue with a customer whose first two
     * attempts found nobody.
     *
     * The retry of a failed request does **not** spend from this budget twice
     * in any meaningful sense — a retry carries the same idempotency key and
     * returns the existing order — but it does spend a token, which is why
     * the number has room rather than being cut to the bone.
     */
    ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR: boundedInt(20, 1, 10_000),
    ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR: boundedInt(40, 1, 10_000),
    /**
     * The most problem photos a customer may attach to one order (issue #83).
     *
     * A tuning parameter kept in configuration rather than a table CHECK —
     * the same shape `MAX_ORDER_REDISPATCHES` takes, for the same reason: the
     * cap is enforced atomically against `orders.photo_count` by the
     * conditional UPDATE in `order-photos.repository.ts#attach`, not by a
     * frozen number in the schema. Six is a starting hypothesis, not a
     * product decision anybody was asked to make (CLAUDE.md §17) — high
     * enough that a genuinely damaged appliance photographed from several
     * angles is never blocked, low enough that a customer cannot turn one
     * order into an unbounded storage bill.
     */
    MAX_ORDER_PHOTOS: boundedInt(6, 1, 20),

    // --- Maps & geocoding (ADR-0004) ---------------------------------------
    // Defaults to `stub` so a clone of this repository runs, and its tests
    // pass, with no billing account and no key — the same shape `SMS_PROVIDER`
    // takes. The stub refuses to construct under NODE_ENV=production, so the
    // default cannot quietly ship.
    MAPS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['google', 'stub']).default('stub')),
    GOOGLE_MAPS_SERVER_API_KEY: optionalString(),
    /**
     * **Capped at 30 days by Google's licence, not by our judgement.** Maps
     * Service Specific Terms §6.3.1: "Customer may temporarily cache latitude
     * (lat) and longitude (lng) values from the Geocoding API for up to 30
     * consecutive calendar days, after which Customer must delete the cached
     * latitude and longitude values."
     *
     * The maximum is therefore part of the schema rather than a comment: an
     * operator who sets 90 gets a boot failure naming the variable, instead of
     * a cache that silently breaches the terms the platform is used under. The
     * default sits at the ceiling because a geocoded point does not go stale —
     * a building does not move — so the only reason to expire it is the licence.
     */
    GEOCODE_CACHE_TTL_DAYS: boundedInt(30, 1, 30),
    /** Google's supported-language code for responses. `az` is in its table. */
    GEOCODE_LANGUAGE: z.preprocess(emptyToUndefined, z.string().min(2).max(8).default('az')),
    /** ISO 3166-1 alpha-2, used as an enforced `components=country:` filter. */
    GEOCODE_COUNTRY: z.preprocess(emptyToUndefined, z.string().length(2).default('AZ')),
    /**
     * A geocode is on the path of a customer saving an address, so it may not
     * hang: past a few seconds the honest answer is "type it yourself".
     */
    GEOCODE_TIMEOUT_MS: boundedInt(4_000, 500, 30_000),
    /**
     * Every allowed call spends money, exactly like an OTP send — which is why
     * these budgets are small and why the endpoints carry a limit at all.
     */
    GEOCODE_RATE_LIMIT_PER_USER_HOUR: boundedInt(60, 1, 10_000),
    GEOCODE_RATE_LIMIT_PER_IP_HOUR: boundedInt(120, 1, 10_000),

    // --- SMS / OTP (ADR-0008) ------------------------------------------
    // Only 'stub' exists today (docs/product/... nothing sends a real SMS
    // yet). Extend this enum only when a real provider is actually wired up.
    SMS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['stub']).default('stub')),
    SMS_API_KEY: optionalString(),
    SMS_SENDER_ID: optionalString(),
    // The pepper every OTP code is HMAC'd under before it reaches a database
    // row. Optional here and required by the module that needs it (`OtpModule`
    // — see `otp.config.ts`), exactly like the JWT secrets and the rate-limit
    // pepper above.
    //
    // It is what makes a stored code useless in a dump: a six-digit code is
    // ~20 bits, so an unkeyed digest of one is invertible by enumeration in
    // milliseconds. `docs/engineering/dependency-policy.md` records why the
    // answer is a keyed digest rather than a slow KDF.
    OTP_CODE_PEPPER: signingSecret(),
    // Bounded, not merely positive. ADR-0008 § Security requirements fixes the
    // code at "6 digits, generated with a CSPRNG": five digits drops the
    // keyspace by 90% against the attempt cap, and the upper bound is a
    // usability floor — nobody transcribes a twelve-digit code from a
    // notification correctly, they paste or give up. A value outside this
    // range is a misconfiguration of a security control, so it stops the
    // deploy with the variable's name in the message rather than silently
    // weakening (or breaking) sign-in.
    OTP_LENGTH: boundedInt(6, 6, 8),
    // Same reasoning, and this one is the ADR's own words: "TTL ≤ 5 minutes",
    // which `positiveInt` could not hold — `OTP_TTL_SECONDS=86400` passed it
    // and left a code redeemable for a day, widening exactly the brute-force
    // and interception window the bound exists to close. The floor is the
    // other failure: a TTL shorter than the time an SMS takes to arrive means
    // every code expires in flight, and `docs/engineering/security.md`
    // § Environment validation names `OTP_TTL_SECONDS=0` as its example of a
    // range that must be validated.
    OTP_TTL_SECONDS: boundedInt(300, 60, 300),
    // Bounded, not merely positive — see `boundedInt`. A six-digit code has a
    // keyspace of 10^6, so ten guesses is already 1-in-100,000 per code and
    // anything beyond that stops being a cap; ADR-0008 fixes the value at 5.
    OTP_MAX_ATTEMPTS: boundedInt(5, 1, 10),
    // 100 SMS per hour to one number is not a rate limit, it is a bill. The
    // ceiling exists so an extra zero fails the deploy instead of the budget.
    OTP_RATE_LIMIT_PER_PHONE_HOUR: boundedInt(5, 1, 100),
    // Higher, because a carrier NAT legitimately puts many real users behind
    // one address — but still bounded for the same reason.
    OTP_RATE_LIMIT_PER_IP_HOUR: boundedInt(20, 1, 10_000),

    // --- Authentication rate limiting (issue #28, ADR-0008) ---------------
    // The pepper every phone number and IP is hashed under before it becomes
    // a Redis key. Optional here and required by `RateLimitModule`, exactly
    // like the two JWT secrets above: the module that needs a value is the
    // one that fails startup without it.
    RATE_LIMIT_KEY_SECRET: signingSecret(),
    // Sign-in on the consumer path IS OTP verify
    // (docs/architecture/authentication.md § Rate limiting); the same policy
    // covers the admin email + password + TOTP form when EPIC 13 lands.
    // Higher than the OTP request budget because verifying costs nothing to
    // serve — the control here is credential guessing, not spend, and the
    // per-code attempt cap is what actually bounds guessing.
    SIGNIN_RATE_LIMIT_PER_IDENTIFIER_HOUR: boundedInt(10, 1, 1_000),
    SIGNIN_RATE_LIMIT_PER_IP_HOUR: boundedInt(30, 1, 10_000),
    // Refresh is limited per SESSION, and generously: a legitimate client
    // rotates roughly once per access-token lifetime (4/hour at the default
    // 15m), so 60 leaves room for retries and clock skew while still turning
    // a stolen refresh token replayed in a loop into a 429.
    REFRESH_RATE_LIMIT_PER_SESSION_HOUR: boundedInt(60, 1, 10_000),
    REFRESH_RATE_LIMIT_PER_IP_HOUR: boundedInt(120, 1, 10_000),
    // "With backoff" (ADR-0008): each request made while already over a limit
    // pushes that window's reset out by one more window, capped at this
    // multiple of it. 1 disables backoff and keeps a plain fixed window.
    AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER: boundedInt(4, 1, 24),

    // --- Price-range rate limiting (issue #84) -----------------------------
    // Not authentication and not a paid third-party call — the only budget
    // standing between an unauthenticated, uncached, live-computed
    // join-plus-aggregate and `master_services` (see the doc comment on
    // `RateLimitPolicyName` in `infra/rate-limit/rate-limit.config.ts`). A
    // signed-in browsing session can reasonably view dozens of services;
    // the per-IP budget is looser to absorb a carrier NAT the same way
    // `OTP_RATE_LIMIT_PER_IP_HOUR` does.
    PRICE_RANGE_RATE_LIMIT_PER_USER_HOUR: boundedInt(120, 1, 10_000),
    PRICE_RANGE_RATE_LIMIT_PER_IP_HOUR: boundedInt(300, 1, 10_000),

    // --- Master presence (issue #40) --------------------------------------
    /**
     * How long a master stays "live" with no heartbeat.
     *
     * **Not a documented number.** `docs/architecture/realtime-architecture.md`
     * fixes the mechanism — "Redis with a TTL, refreshed by a heartbeat" — and
     * supplies no seconds, so this is an engineering choice with its reasons
     * written down rather than a value copied from a doc.
     *
     * Three times the heartbeat interval, so two beats can be lost to a tunnel,
     * a garbage collection pause or a bad minute of mobile signal before a
     * working master is dropped. Shorter and a master flickers offline on a
     * normal Baku commute; much longer and the TTL stops doing the one job it
     * exists for, which is making a crashed app self-correcting.
     *
     * The floor is two heartbeats' worth; the ceiling is ten minutes, past
     * which a switched-off phone is being offered work for long enough that a
     * customer notices.
     */
    PRESENCE_TTL_SECONDS: boundedInt(180, 30, 600),
    /**
     * How often the app is told to refresh its presence.
     *
     * Aligned with the 60–120 s location-reporting interval for a master who is
     * online with no order (realtime-architecture.md § Location update budget),
     * so the heartbeat rides alongside a report the app was already going to
     * make rather than adding a wake-up of its own to somebody's battery.
     */
    PRESENCE_HEARTBEAT_SECONDS: boundedInt(60, 10, 300),

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
    // A heartbeat at least as long as the TTL means presence expires before
    // the next beat arrives: every master flickers offline between heartbeats,
    // dispatch finds nobody, and nothing in the logs says why. Both values pass
    // their own range checks, so only a comparison catches it.
    if (value.PRESENCE_HEARTBEAT_SECONDS * 2 > value.PRESENCE_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRESENCE_TTL_SECONDS'],
        message:
          'must be at least twice PRESENCE_HEARTBEAT_SECONDS, so a master survives a missed beat',
      });
    }

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
        message: 'must be a different value from JWT_ACCESS_SECRET',
      });
    }

    // Same argument, third secret. The rate-limit pepper is handed to
    // `createHmac` over attacker-chosen input (a phone number the caller
    // supplies), which is not a position to put a token-signing key in — and
    // a secret shared between two subsystems cannot be rotated for one of
    // them without breaking the other, so it never gets rotated at all.
    if (
      value.RATE_LIMIT_KEY_SECRET !== undefined &&
      (value.RATE_LIMIT_KEY_SECRET === value.JWT_ACCESS_SECRET ||
        value.RATE_LIMIT_KEY_SECRET === value.JWT_REFRESH_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_KEY_SECRET'],
        message: 'must be a different value from JWT_ACCESS_SECRET and JWT_REFRESH_SECRET',
      });
    }

    // Same argument, fifth secret — and the one whose reuse would be worst.
    // The admin key signs tokens that suspend masters and read personal data
    // across the platform; sharing it with the consumer key would mean a
    // consumer-side signing bug is an admin compromise, and it could never be
    // rotated on its own.
    if (
      value.JWT_ADMIN_ACCESS_SECRET !== undefined &&
      (value.JWT_ADMIN_ACCESS_SECRET === value.JWT_ACCESS_SECRET ||
        value.JWT_ADMIN_ACCESS_SECRET === value.JWT_REFRESH_SECRET ||
        value.JWT_ADMIN_ACCESS_SECRET === value.RATE_LIMIT_KEY_SECRET ||
        value.JWT_ADMIN_ACCESS_SECRET === value.OTP_CODE_PEPPER)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ADMIN_ACCESS_SECRET'],
        message: 'must be a different value from every other signing secret',
      });
    }

    // Same argument, fourth secret — and the one with the shortest blast
    // radius if it is shared, which is why it gets its own. The OTP pepper is
    // the only thing standing between a leaked `otp_challenges` dump and a
    // list of live codes, so it must be rotatable the moment that dump is
    // suspected. A pepper that doubles as a token-signing key cannot be
    // rotated without signing every user out, which means in practice it is
    // not rotated at all.
    if (
      value.OTP_CODE_PEPPER !== undefined &&
      (value.OTP_CODE_PEPPER === value.JWT_ACCESS_SECRET ||
        value.OTP_CODE_PEPPER === value.JWT_REFRESH_SECRET ||
        value.OTP_CODE_PEPPER === value.RATE_LIMIT_KEY_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_CODE_PEPPER'],
        message:
          'must be a different value from JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and RATE_LIMIT_KEY_SECRET',
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
      refreshReuseGraceSeconds: env.REFRESH_REUSE_GRACE_SECONDS,
    }),
    rateLimit: Object.freeze({
      keySecret: env.RATE_LIMIT_KEY_SECRET,
      signInPerIdentifierHour: env.SIGNIN_RATE_LIMIT_PER_IDENTIFIER_HOUR,
      signInPerIpHour: env.SIGNIN_RATE_LIMIT_PER_IP_HOUR,
      refreshPerSessionHour: env.REFRESH_RATE_LIMIT_PER_SESSION_HOUR,
      refreshPerIpHour: env.REFRESH_RATE_LIMIT_PER_IP_HOUR,
      backoffMultiplier: env.AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER,
      priceRangePerUserHour: env.PRICE_RANGE_RATE_LIMIT_PER_USER_HOUR,
      priceRangePerIpHour: env.PRICE_RANGE_RATE_LIMIT_PER_IP_HOUR,
    }),
    admin: Object.freeze({
      accessSecret: env.JWT_ADMIN_ACCESS_SECRET,
      accessTtl: env.ADMIN_ACCESS_TTL,
      sessionTtl: env.ADMIN_SESSION_TTL,
      idleTimeout: env.ADMIN_SESSION_IDLE_TIMEOUT,
    }),
    storage: Object.freeze({
      provider: env.STORAGE_PROVIDER,
      presignTtlSeconds: env.UPLOAD_PRESIGN_TTL_SECONDS,
      downloadTtlSeconds: env.UPLOAD_DOWNLOAD_TTL_SECONDS,
      verificationDocumentMaxBytes: env.VERIFICATION_DOCUMENT_MAX_BYTES,
      orderPhotoMaxBytes: env.ORDER_PHOTO_MAX_BYTES,
      uploadPresignPerUserHour: env.UPLOAD_PRESIGN_RATE_LIMIT_PER_USER_HOUR,
      uploadPresignPerIpHour: env.UPLOAD_PRESIGN_RATE_LIMIT_PER_IP_HOUR,
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
      geocodeLanguage: env.GEOCODE_LANGUAGE,
      geocodeCountry: env.GEOCODE_COUNTRY,
      geocodeTimeoutMs: env.GEOCODE_TIMEOUT_MS,
      geocodePerUserHour: env.GEOCODE_RATE_LIMIT_PER_USER_HOUR,
      geocodePerIpHour: env.GEOCODE_RATE_LIMIT_PER_IP_HOUR,
    }),
    sms: Object.freeze({
      provider: env.SMS_PROVIDER,
      apiKey: env.SMS_API_KEY,
      senderId: env.SMS_SENDER_ID,
      otp: Object.freeze({
        codePepper: env.OTP_CODE_PEPPER,
        length: env.OTP_LENGTH,
        ttlSeconds: env.OTP_TTL_SECONDS,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        rateLimitPerPhoneHour: env.OTP_RATE_LIMIT_PER_PHONE_HOUR,
        rateLimitPerIpHour: env.OTP_RATE_LIMIT_PER_IP_HOUR,
      }),
    }),
    presence: Object.freeze({
      ttlSeconds: env.PRESENCE_TTL_SECONDS,
      heartbeatSeconds: env.PRESENCE_HEARTBEAT_SECONDS,
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
      createPerUserHour: env.ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR,
      createPerIpHour: env.ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR,
      maxPhotosPerOrder: env.MAX_ORDER_PHOTOS,
    }),
    notifications: Object.freeze({
      expoAccessToken: env.EXPO_ACCESS_TOKEN,
    }),
    observability: Object.freeze({
      logLevel: env.LOG_LEVEL,
    }),
  });
}
