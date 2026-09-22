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
    /**
     * The namespace every Redis key this application builds itself is written
     * under — presence (`<prefix>:presence:master:<id>`) and the catalogue
     * cache (`<prefix>:catalogue:v1:…`) today, and anything added later
     * (#125).
     *
     * It exists for `QUEUE_PREFIX`'s reason, which is not a queue reason:
     * Redis is shared. Two checkouts, or a CI job and a developer's
     * `pnpm test`, point at one container, and a keyspace whose name is a
     * constant lets one run read, overwrite and delete another's. Presence was
     * the case that actually bit — `test/nearby-masters.integration.test.ts`
     * carried a hand-written cleanup precisely because it could not glob its
     * own keys without taking two other suites' with them.
     *
     * **Separate from `QUEUE_PREFIX` on purpose, not by omission.** The two
     * are the same idea and would work as one variable; they are kept apart
     * because renaming them costs different things. `QUEUE_PREFIX` names a
     * keyspace BullMQ owns and whose layout is its own, and moving it strands
     * every delayed job already in flight — a dispatch wave that never widens.
     * This one names keyspaces we own, all of which are caches of something
     * authoritative elsewhere: moving it costs one cold interval and nothing
     * else. An operator must be able to pay the second price without paying
     * the first.
     *
     * Restricted to a short identifier for `QUEUE_PREFIX`'s reason as well —
     * the value is concatenated into every key, so a colon or a brace in it
     * would silently reshape the key space (and, on a cluster, the hash slot)
     * instead of failing.
     */
    REDIS_KEY_PREFIX: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be 1-32 characters of a-z, A-Z, 0-9, _ or -')
        .default('tezusta'),
    ),

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
     * Status transitions one master may perform per hour (issue #134).
     *
     * A different shape of abuse from order creation, and a much milder one:
     * a transition rings nobody's phone and costs nothing at a third party.
     * What it bounds is a client stuck in a retry loop — a mobile app that
     * re-sends "I have arrived" on every reconnect — writing audit rows
     * nobody asked for against a table that is append-only and can never be
     * tidied up afterwards.
     *
     * A hundred and twenty is far above any real day: an order takes four
     * transitions, so this is thirty finished jobs in an hour by one master.
     * It is deliberately loose, because the failure it guards against is a
     * bug in our own client and the cost of refusing a legitimate master
     * mid-job is a support call.
     */
    ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR: boundedInt(120, 1, 10_000),
    ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR: boundedInt(240, 1, 10_000),
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

    /**
     * Messages one party may send per hour, and per IP (issue #178).
     *
     * What this bounds is not a bill and not a credential guess. A
     * conversation is a private channel between two strangers that the
     * platform opened (ADR-0033), and every send writes a row into a
     * write-once transcript that can never be tidied up afterwards — so the
     * two things worth stopping are a client stuck in a retry loop and a party
     * using the channel to harass the other.
     *
     * Three hundred is far above any real exchange about a repair: settling an
     * entrance, a floor and an arrival time is a dozen messages, and the
     * loudest honest conversation in a day does not reach a tenth of this. It
     * is deliberately loose because the cost of refusing a real message
     * mid-job — a master outside the wrong building — is a job that does not
     * happen. Harassment is not a rate-limiting problem and is not solved
     * here; blocking and reporting are EPIC 15's.
     */
    MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR: boundedInt(300, 1, 10_000),
    MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR: boundedInt(600, 1, 10_000),

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

    // --- Realtime gateway (issue #166) -------------------------------------
    /**
     * How many sockets one account may hold at once, across every device.
     *
     * A bound on resource use from a malicious client
     * (`realtime-architecture.md` § Security), not a product limit on devices.
     * Five is above any honest use — a phone and a tablet, each briefly
     * holding a stale socket during a reconnect — and far below what a client
     * looping `io()` would open.
     *
     * Past the cap the **oldest** socket is closed rather than the new one
     * refused; see `connection.registry.ts` for why that direction is the one
     * that does not lock out a master coming back from a tunnel.
     *
     * The ceiling is deliberately low. A high value here does not fail
     * anything at boot — it just stops being a bound, which is worse than
     * refusing to start.
     */
    REALTIME_MAX_CONNECTIONS_PER_USER: boundedInt(5, 1, 50),

    // --- Master location reporting (issue #98) -----------------------------
    /**
     * How long one master's position trail is kept.
     *
     * **A retention rule, not a tuning knob.** `master_locations` holds the
     * most sensitive data in the schema, and
     * `docs/architecture/database-architecture.md` requires it to be aged out:
     * "keep everything forever is a liability, not a feature". There is no
     * scheduler in this repository to sweep on, so the bound is applied by the
     * write path — each report deletes that master's rows older than this,
     * inside the transaction that inserts the new one
     * (`MasterLocationRepository.record`).
     *
     * One hour by default because nothing reads the trail yet: dispatch and
     * live tracking both want the latest row only, so the trail's whole
     * present value is being able to explain a report that looks wrong. When
     * something does read it — an order's route, a dispute — the number is
     * that feature's to raise, with its reason. The floor is five minutes,
     * short enough to be useful in a test and still long enough that the
     * latest position is never the only one; the ceiling is a day, past which
     * this stops being retention.
     */
    MASTER_LOCATION_TRAIL_MINUTES: boundedInt(60, 5, 1440),
    /**
     * Position reports one master may send per hour, and per IP.
     *
     * Sized from the budget in `docs/architecture/realtime-architecture.md`
     * § Location update budget rather than picked: the fastest state there is
     * "assigned, travelling" at one report every 10–15 s, which is 240–360 an
     * hour, and 600 leaves room for retries after a tunnel without leaving
     * room for a loop. **The server is the authority on the interval**, which
     * is what this enforces — a client that decides to report every second
     * gets 429s, not a faster trail.
     *
     * The per-IP half is deliberately loose. Masters are on mobile networks,
     * where a carrier NAT puts an unknown number of them behind one address,
     * so a tight per-IP budget would throttle a whole city block of masters
     * for one phone's bug. It is a ceiling against a single abusive host, not
     * the control — the per-master budget is the control.
     */
    MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR: boundedInt(600, 1, 10_000),
    MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR: boundedInt(3000, 1, 10_000),

    /**
     * Offer responses — accepts and declines — one master may send per hour
     * (issue #101).
     *
     * Sized from the model rather than from a load test. ADR-0009 broadcasts
     * every order to the nearest 20 eligible masters, so a master working a
     * busy district sees offers far faster than they can work jobs and is
     * expected to decline most of them: 300 an hour is one response every
     * twelve seconds, sustained, which is well past what a human does with a
     * phone and well short of what a script does with a loop. The point is not
     * to ration honest use; it is that on a first-accept-wins model an
     * unthrottled `accept` loop is how one client takes every job in the city.
     *
     * The per-IP half is loose for `MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR`'s
     * reason, and it is the same population: masters behind one carrier NAT.
     */
    MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR: boundedInt(300, 1, 10_000),
    MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR: boundedInt(3000, 1, 10_000),

    /**
     * Offer **feed** reads one master may make per hour (issue #101).
     *
     * Sized from the polling interval, which is the only thing that sets it:
     * until EPIC 9's realtime channel lands, an online master's app discovers
     * new offers by polling `GET /masters/me/offers`, and
     * `docs/product/master-flow.md` wants that to feel immediate. **The number
     * assumes a five-second poll** — 720 reads an hour — and 900 leaves room
     * for pull-to-refresh, app restarts and a retry after a dropped request
     * without ever letting an honest client hit the limit. A client polling
     * appreciably faster than every four seconds is not what the product asks
     * for, and it is spending a feed read each time.
     *
     * Separate from `MASTER_OFFER_RESPONSE_RATE_LIMIT_*` because the two are
     * different shapes of use. One number cannot size both: a budget generous
     * enough for a continuous poll leaves `accept` effectively unlimited,
     * which is the loop ADR-0009's first-accept-wins model is most exposed
     * to, and a budget tight enough for `accept` throttles the poll the
     * product depends on.
     *
     * **When EPIC 9 replaces the polling, this number should come down** —
     * a push channel makes a five-second poll a bug rather than a design.
     *
     * The per-IP half is loose for `MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR`'s
     * reason, and more so: this is the same population behind the same
     * carrier NATs, each of them polling.
     */
    MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR: boundedInt(900, 1, 10_000),
    MASTER_OFFER_FEED_RATE_LIMIT_PER_IP_HOUR: boundedInt(9000, 1, 10_000),

    // --- Device registry (EPIC 10, issue #140) ------------------------------
    /**
     * Device registrations one account may make per hour, and per IP.
     *
     * **This bounds table growth, not a bill and not a credential guess.**
     * Every accepted row is an address the notification worker will fan out
     * to and that issue #142 will chase a receipt for, so a client looping on
     * `POST /devices` with fresh tokens costs real work on every later send —
     * and none of those tokens is ever deliverable.
     *
     * Sixty is far above honest use and deliberately so. A real client
     * registers on sign-in, on each token rotation, and on launch; a person
     * reinstalling the app several times in an hour is at single digits. The
     * ceiling argues with a script, never with a user.
     *
     * The per-IP half is loose for `MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR`'s
     * reason — this is the same population behind the same carrier NATs, and
     * a shared exit must not lock out a whole building.
     */
    DEVICE_REGISTRATION_RATE_LIMIT_PER_USER_HOUR: boundedInt(60, 1, 10_000),
    DEVICE_REGISTRATION_RATE_LIMIT_PER_IP_HOUR: boundedInt(600, 1, 10_000),

    // --- Dispatch (ADR-0009) ------------------------------------------------
    DISPATCH_INITIAL_RADIUS_M: positiveInt(3000),
    DISPATCH_MAX_RADIUS_M: positiveInt(10000),
    DISPATCH_RADIUS_STEP_SECONDS: positiveInt(30),
    DISPATCH_TOTAL_TIMEOUT_SECONDS: positiveInt(180),
    DISPATCH_MAX_MASTERS_PER_BROADCAST: positiveInt(20),
    /**
     * How old a master's newest position may be before dispatch treats them as
     * **missing** rather than as "in range at their last known point"
     * ([ADR-0026](docs/decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
     *
     * **Deliberately not `PRESENCE_TTL_SECONDS`.** The two windows answer
     * different questions and only one implication holds between them: a
     * position report refreshes presence, but a heartbeat writes no position.
     * A master parked 800 m away, beating every 60 s and not moving, is live
     * in Redis with a position that stops being refreshed — and bounding the
     * position by the presence TTL deleted exactly that master from every
     * broadcast. What this bound is for is a position left over from a
     * *previous* session: app killed at A, master drives to B, reopens,
     * presence refreshes instantly and the first report has not landed yet.
     *
     * **The default is derived, not chosen.** `realtime-architecture.md`
     * § Location update budget now guarantees a reporting *floor* — while a
     * master is online the app reports at least once per interval regardless
     * of movement — and the idle interval's slow end is 120 s. One missed
     * report is another 120 s, and 60 s covers a late fix plus clock skew
     * between a phone and the database: 120 + 120 + 60 = 300.
     *
     * The floor of the range is that 120 s interval, below which a
     * budget-compliant app is dropped between two of its own reports. The
     * ceiling is an hour, past which a "recent" position belongs to a previous
     * session and `MASTER_LOCATION_TRAIL_MINUTES` has usually pruned the row
     * anyway.
     */
    DISPATCH_MAX_POSITION_AGE_SECONDS: boundedInt(300, 120, 3600),
    MAX_ORDER_REDISPATCHES: nonNegativeInt(2),
    /**
     * How often the orphaned-search reconciler sweeps, in seconds. **Zero
     * disables it entirely** — no scheduler is upserted and nothing
     * reconciles (issue #115).
     *
     * Zero is a supported mode for `MAINTENANCE_SWEEP_INTERVAL_MINUTES`'
     * reason: the test suites run with it, because a reconciler terminating
     * a search in the background while a suite is asserting on an order that
     * is still searching is a flake nobody would enjoy diagnosing.
     *
     * A minute by default, and the unit is seconds rather than minutes
     * because of what it bounds. An orphaned order is a customer watching a
     * spinner that will never resolve, and the wait they actually experience
     * is `DISPATCH_TOTAL_TIMEOUT_SECONDS` plus the grace below plus,
     * worst-case, one of these intervals. On the shipped numbers that is
     * 180 + 60 + 60 = five minutes — long, but finite, which is the entire
     * difference this makes. The ceiling is an hour, past which the
     * reconciler stops being a backstop for a live search and becomes a
     * cleanup job.
     */
    DISPATCH_RECONCILE_INTERVAL_SECONDS: boundedInt(60, 0, 3_600),
    /**
     * How long past its own deadline an order must have been `SEARCHING`
     * before the reconciler considers it at all.
     *
     * **Slack, not policy.** The give-up job is the mechanism that ends a
     * search; this is only the margin that keeps the reconciler from racing
     * it when a tick is merely late. A tick that throws is retried
     * `QUEUE_JOB_ATTEMPTS` times on an exponential backoff starting at
     * `QUEUE_JOB_BACKOFF_MS`, which on the shipped 3 attempts and 5 s is
     * 5 + 10 = 15 s of retrying; 60 s covers that with room for a worker
     * queue that is briefly behind.
     *
     * **It is not the guard, and the floor reflects that.** What actually
     * stops the reconciler taking an order away from a search still in
     * progress is `DeferredWorkService.isScheduled` — a give-up job that is
     * delayed, waiting or running means "leave this alone" no matter how late
     * it is. This margin only keeps the reconciler from spending a scan on
     * orders in their ordinary completion window. So the floor is one second,
     * low enough for an end-to-end test to drive the whole path in real time,
     * and the default is sized for the retry envelope above rather than for
     * safety it does not provide. The ceiling is an hour.
     */
    DISPATCH_RECONCILE_GRACE_SECONDS: boundedInt(60, 1, 3_600),

    // --- Deferred work / BullMQ (ADR-0025) ---------------------------------
    /**
     * The namespace every BullMQ key is written under
     * (`<prefix>:<queue>:<...>`). BullMQ's own default is `bull`.
     *
     * It is configurable for the reason `RATE_LIMIT_KEY_SECRET` is: Redis is
     * shared. Two checkouts, or a CI job and a developer's `pnpm test`, point
     * at one container, and a queue whose prefix is a constant would have one
     * run's worker consume the other run's jobs — a failure that looks like a
     * flaky test and is actually cross-talk. `test/setup-env.ts` gives each
     * test process its own prefix; deployments give each environment one.
     *
     * Restricted to a short identifier rather than any string: the value is
     * concatenated into every key, and a colon or a brace in it would silently
     * reshape the key space (and, on a cluster, the hash slot) instead of
     * failing.
     */
    QUEUE_PREFIX: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be 1-32 characters of a-z, A-Z, 0-9, _ or -')
        .default('tezusta'),
    ),
    /**
     * Where the BullMQ worker runs.
     *
     * `in-process` — the API replica consumes its own queue. This is what
     * ships today, and it is a deliberate deviation from
     * `docs/architecture/backend-architecture.md` § Background jobs, which
     * describes a separate worker process. ADR-0025 records why and names the
     * trigger for revisiting it.
     *
     * `off` — the replica produces jobs and consumes none. This is the half
     * of the extraction that exists now: a separate worker deployment is a new
     * bootstrap file plus this flag set to `off` on the API, not a redesign.
     */
    QUEUE_WORKER_MODE: z.preprocess(
      emptyToUndefined,
      z.enum(['in-process', 'off']).default('in-process'),
    ),
    /**
     * Jobs one worker runs at once. Bounded, not merely positive: a dispatch
     * tick is a short database write, so a large number buys nothing and
     * multiplies the Postgres connections a replica can demand at one moment
     * past `DATABASE_POOL_MAX`.
     */
    QUEUE_WORKER_CONCURRENCY: boundedInt(5, 1, 100),
    /**
     * Total attempts per job, retries included — `1` disables retrying.
     * Bounded above because every attempt after the first runs against an
     * order whose state has already moved on, and a job that retries for an
     * hour is a job that fires into a completed order.
     */
    QUEUE_JOB_ATTEMPTS: boundedInt(3, 1, 10),
    /**
     * Base delay for the exponential backoff between attempts, in
     * milliseconds. The nth retry waits `QUEUE_JOB_BACKOFF_MS * 2^(n-1)`.
     */
    QUEUE_JOB_BACKOFF_MS: boundedInt(5_000, 100, 300_000),

    // --- Maintenance sweeps (#57, #69, #92) --------------------------------
    /**
     * How often each retention sweep runs, in minutes. **Zero disables
     * scheduling entirely** — no scheduler is upserted and nothing sweeps.
     *
     * Zero is a supported operating mode rather than a way to spell "off by
     * accident": the test suites run with it, because a background job
     * deleting expired rows while a suite is asserting on expired rows is a
     * flake nobody would enjoy diagnosing, and a deployment that wants its
     * retention driven from outside (a cron container, an operator running
     * one sweep by hand) has somewhere to say so.
     *
     * The ceiling is a day. A retention rule that runs less often than that
     * is a retention rule whose window is really the interval, and
     * `GEOCODE_CACHE_TTL_DAYS` is capped at thirty by a licence
     * (`docs/decisions/ADR-0022-geocode-cache-stores-coordinates-only.md`).
     */
    MAINTENANCE_SWEEP_INTERVAL_MINUTES: boundedInt(60, 0, 1_440),
    /**
     * The most rows one sweep iteration deletes, per table.
     *
     * Bounded because this is the number that decides how long a single
     * statement holds locks on a table a request path is using
     * (CLAUDE.md §12). A sweep that cannot finish in one iteration simply
     * finishes in the next one; a sweep that deletes a million rows in one
     * transaction is an outage.
     */
    MAINTENANCE_BATCH_SIZE: boundedInt(1_000, 1, 50_000),
    /**
     * How long a spent or expired refresh token — and the session it belongs
     * to — is kept after it stops being usable (#57).
     *
     * **Not a storage number: a security one.** Reuse detection works by a
     * replayed token landing on a row that exists and is already marked used
     * (`infra/database/schema/sessions.ts`), so deleting a spent row early
     * turns a theft signal into "no such token". The `superRefine` below
     * refuses any value shorter than `JWT_REFRESH_TTL`, which would delete
     * live credentials; the default leaves a fortnight of slack past the
     * shipped 30-day family for an incident to be investigated after the
     * fact.
     */
    AUTH_RETENTION_DAYS: boundedInt(45, 1, 400),
    /**
     * The same thing, for a family revoked because refresh-token **reuse was
     * detected** (#57).
     *
     * Longer than the ordinary window because those rows are the only record
     * that a theft signal fired, and an investigation may start long after
     * the event. Bounded rather than infinite because a signal old enough
     * that nobody will ever read it is session metadata kept for no reason,
     * and this repository treats retention as a requirement rather than a
     * nicety (CLAUDE.md §11) — `master_locations` and `geocode_cache` are
     * both bounded for the same reason.
     *
     * **A year, decided in ADR-0027** (#126), not a placeholder: that is the
     * outer edge of when the question these rows answer still arrives — a
     * user reporting a sign-in they do not recognise comes weeks to months
     * after the event, not years. The row is kept whole for it and then
     * deleted; the ADR records why a reduced record and a second, shorter
     * token window were both rejected.
     *
     * The `superRefine` below still refuses a value below
     * `AUTH_RETENTION_DAYS`, since a shorter incident window would mean a
     * theft record retired before an ordinary sign-out.
     */
    AUTH_INCIDENT_RETENTION_DAYS: boundedInt(365, 1, 3_650),
    /**
     * How long a confirmed-but-never-attached order photo is kept before the
     * sweep deletes its object and its row (#92).
     *
     * A customer may photograph the leak before deciding whether to submit
     * the request at all, so upload and attach are deliberately independent
     * (issue #83) — which is exactly why an abandoned photo exists as a
     * category. The window is generous rather than tight because the failure
     * it must not produce is deleting the photo of an order somebody is
     * still filling in.
     */
    ORDER_PHOTO_ABANDONED_AFTER_HOURS: boundedInt(24, 1, 720),
    /**
     * How long a presigned-but-never-confirmed verification document is kept
     * before the sweep deletes its object and its row (#128).
     *
     * **Measured from the master's last document activity, not from the
     * document's own upload** — a deliberate choice, not an inherited
     * default. The failure to avoid is a master part-way through gathering
     * three documents: measuring each one separately deletes the oldest out
     * from under somebody who is still working, and that person is precisely
     * the one who needed the time. So the window means "this applicant
     * stopped", not "this row is old".
     *
     * **A separate knob from `ORDER_PHOTO_ABANDONED_AFTER_HOURS`, and much
     * longer.** An order photo is a picture of a leaking tap taken minutes
     * before the request; a verification document is an identity document
     * (ADR-0023) gathered over days, often across two devices and a trip home
     * to find a card. A week is generous on that timescale and still bounded,
     * which is what `docs/engineering/security.md` asks of anything holding
     * personal data.
     *
     * The ceiling is ninety days. Past that the number stops being a
     * retention rule for an abandoned application and starts being "keep
     * identity documents indefinitely", which is the thing this sweep exists
     * to stop.
     */
    MASTER_DOCUMENT_ABANDONED_AFTER_HOURS: boundedInt(168, 1, 2_160),

    // --- Order lifecycle and commission ------------------------------------
    MAX_COMMISSION_DEBT_MINOR: nonNegativeInt(5000),
    DISPUTE_WINDOW_HOURS: positiveInt(72),

    // --- Push notifications (EPIC 10, issue #141) --------------------------
    /**
     * Which push transport delivers.
     *
     * Unlike `SMS_PROVIDER`, the real provider **exists** — Expo's push
     * service is decided (`technology-stack.md`), not open. The default is
     * still `stub` for the reason every other provider here defaults to one:
     * a clone of this repository runs, and its tests pass, with no Expo
     * account. `StubPushSender` refuses to construct under
     * NODE_ENV=production, so the default cannot quietly ship a service that
     * reports green on every health check and delivers nothing.
     */
    PUSH_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['expo', 'stub']).default('stub')),
    /**
     * Expo's optional push-security credential.
     *
     * Optional because Expo's send endpoint accepts unauthenticated requests
     * by default; a project that has enabled push security must set it or
     * every send is refused. It is a **secret** — it authorises sending to
     * this project's devices — so it never carries the `EXPO_PUBLIC_` prefix
     * (CLAUDE.md §4).
     */
    EXPO_ACCESS_TOKEN: optionalString(),

    // --- Push receipts (EPIC 10, issue #142) -------------------------------
    /**
     * How often the receipt sweep runs. `0` disables it.
     *
     * Not a tuning knob for throughput — the sweep is bounded per run — but
     * for how quickly a dead token stops costing sends. Five minutes means a
     * device uninstalled at noon is retired within about twenty, once Expo's
     * own delay below is added.
     *
     * Disabling it is a real operational choice (an incident, a migration),
     * and it has to mean the scheduler is **removed**, not merely not added —
     * see `PushReceiptsService.onApplicationBootstrap`.
     */
    PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS: nonNegativeInt(300),
    /**
     * How long a ticket must sit before Expo is asked about it.
     *
     * **900 seconds because Expo says so**, not because it felt right:
     * *"We recommend checking push receipts 15 minutes after sending your push
     * notifications. While push receipts are often available much sooner, a
     * 15-minute window gives the Expo push notification service a comfortable
     * amount of time to make the receipts available to you."*
     * (docs.expo.dev/push-notifications/sending-notifications, § Check push
     * receipts for errors, read 21 September 2026.)
     *
     * Asking sooner is not an error — a receipt that is not ready is simply
     * absent from the answer and its row waits for the next run — it is just
     * a request that buys nothing.
     */
    PUSH_RECEIPT_MIN_AGE_SECONDS: positiveInt(900),
    /**
     * How long a ticket stays on the worklist before it is dropped unanswered.
     *
     * **24 hours, from the same page**: *"Lastly, push receipts are cleared
     * after 24 hours."* The shipped `expo-server-sdk@7.2.0` README is looser —
     * *"The receipts will be available for at least a day"* — and its
     * `build/ExpoClient.d.ts` looser still, *"approximately a day"*. The
     * documented number is the conservative read of all three: after it, Expo
     * has no answer and a row that stays is a row asked about forever.
     */
    PUSH_RECEIPT_RETENTION_HOURS: positiveInt(24),
    /**
     * The most tickets one run resolves before leaving the rest to the next.
     *
     * A sweep that drains the table is the job that fills a worker on the one
     * day it matters — a backlog after an outage — and delays every
     * notification behind it. The backlog is still there next interval, and
     * the rows closest to expiry are taken first.
     */
    PUSH_RECEIPT_MAX_PER_RUN: positiveInt(1000),

    // --- Observability -------------------------------------------------
    /**
     * The least severe line the process writes — a threshold, expanded into
     * Nest's enabled-level set by `infra/observability/log-levels.ts` and
     * installed in `main.ts` (#129).
     *
     * **No default here, deliberately.** The right default depends on
     * `NODE_ENV`, and `toAppConfig` applies it: `production` gets `info`,
     * every other environment gets `debug`. A single default could not be
     * both "production does not pay for a `debug` line on every cache miss"
     * and "nobody's local development goes quiet on the release that made
     * this variable start working", and issue #129 asks for the second in as
     * many words.
     *
     * `error` is refused under `NODE_ENV=production` by the `superRefine`
     * below: expected client errors and rate-limit triggers are logged at
     * `warn` (#56), and `docs/engineering/security.md` § Logging requires
     * those triggers to stay logged.
     */
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['debug', 'info', 'warn', 'error']).optional(),
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

    // The auth retention sweep (#57) deletes refresh tokens and sessions past
    // this window. Set it shorter than the refresh family's own lifetime and
    // it deletes **live credentials**: a user signed in on a device that has
    // not refreshed recently is signed out by a maintenance job, and — worse
    // — the spent rows reuse detection reads are gone before the family they
    // belong to has expired, so a replayed token hashes to nothing and the
    // theft signal is silently lost. Both values pass their own range checks,
    // so only this comparison catches it.
    const retentionMs = value.AUTH_RETENTION_DAYS * 86_400_000;
    if (DURATION_PATTERN.test(value.JWT_REFRESH_TTL)) {
      const refreshTtlMs = parseDurationMs(value.JWT_REFRESH_TTL);
      if (retentionMs < refreshTtlMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_RETENTION_DAYS'],
          message: `must be at least JWT_REFRESH_TTL (${value.JWT_REFRESH_TTL}), or the sweep deletes credentials that are still live`,
        });
      }
    }

    // `LOG_LEVEL=error` is the one threshold that drops `warn`, and `warn` is
    // where every expected client error and every rate-limit trigger is
    // written (#56). `docs/engineering/security.md` § Logging requires those
    // triggers to stay logged, so in production this is not a preference
    // about volume — it is turning a documented security control off. Refused
    // at boot for the reason `STORAGE_PROVIDER=stub` is: a control that can
    // be disabled silently is one that eventually is.
    if (value.NODE_ENV === 'production' && value.LOG_LEVEL === 'error') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_LEVEL'],
        message:
          'must not be "error" under NODE_ENV=production — rate-limit triggers and expected client errors are logged at "warn", and docs/engineering/security.md requires them to stay logged',
      });
    }

    // A theft record retired sooner than an ordinary sign-out is the one
    // ordering that makes the longer window pointless.
    if (value.AUTH_INCIDENT_RETENTION_DAYS < value.AUTH_RETENTION_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_INCIDENT_RETENTION_DAYS'],
        message:
          'must be at least AUTH_RETENTION_DAYS — a refresh-token theft record must outlive an ordinary expired session, never the other way round',
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
      keyPrefix: env.REDIS_KEY_PREFIX,
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
    realtime: Object.freeze({
      maxConnectionsPerUser: env.REALTIME_MAX_CONNECTIONS_PER_USER,
    }),
    masterLocation: Object.freeze({
      trailMinutes: env.MASTER_LOCATION_TRAIL_MINUTES,
      reportPerUserHour: env.MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR,
      reportPerIpHour: env.MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR,
    }),
    masterOffers: Object.freeze({
      responsePerUserHour: env.MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR,
      responsePerIpHour: env.MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR,
      feedPerUserHour: env.MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR,
      feedPerIpHour: env.MASTER_OFFER_FEED_RATE_LIMIT_PER_IP_HOUR,
    }),
    devices: Object.freeze({
      registrationPerUserHour: env.DEVICE_REGISTRATION_RATE_LIMIT_PER_USER_HOUR,
      registrationPerIpHour: env.DEVICE_REGISTRATION_RATE_LIMIT_PER_IP_HOUR,
    }),
    dispatch: Object.freeze({
      initialRadiusM: env.DISPATCH_INITIAL_RADIUS_M,
      maxRadiusM: env.DISPATCH_MAX_RADIUS_M,
      radiusStepSeconds: env.DISPATCH_RADIUS_STEP_SECONDS,
      totalTimeoutSeconds: env.DISPATCH_TOTAL_TIMEOUT_SECONDS,
      maxMastersPerBroadcast: env.DISPATCH_MAX_MASTERS_PER_BROADCAST,
      maxPositionAgeSeconds: env.DISPATCH_MAX_POSITION_AGE_SECONDS,
      maxOrderRedispatches: env.MAX_ORDER_REDISPATCHES,
      reconcileIntervalSeconds: env.DISPATCH_RECONCILE_INTERVAL_SECONDS,
      reconcileGraceSeconds: env.DISPATCH_RECONCILE_GRACE_SECONDS,
    }),
    queue: Object.freeze({
      prefix: env.QUEUE_PREFIX,
      workerMode: env.QUEUE_WORKER_MODE,
      workerConcurrency: env.QUEUE_WORKER_CONCURRENCY,
      jobAttempts: env.QUEUE_JOB_ATTEMPTS,
      jobBackoffMs: env.QUEUE_JOB_BACKOFF_MS,
    }),

    maintenance: Object.freeze({
      sweepIntervalMinutes: env.MAINTENANCE_SWEEP_INTERVAL_MINUTES,
      batchSize: env.MAINTENANCE_BATCH_SIZE,
      authRetentionDays: env.AUTH_RETENTION_DAYS,
      authIncidentRetentionDays: env.AUTH_INCIDENT_RETENTION_DAYS,
      orderPhotoAbandonedAfterHours: env.ORDER_PHOTO_ABANDONED_AFTER_HOURS,
      masterDocumentAbandonedAfterHours: env.MASTER_DOCUMENT_ABANDONED_AFTER_HOURS,
    }),
    orders: Object.freeze({
      maxCommissionDebtMinor: env.MAX_COMMISSION_DEBT_MINOR,
      disputeWindowHours: env.DISPUTE_WINDOW_HOURS,
      createPerUserHour: env.ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR,
      createPerIpHour: env.ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR,
      transitionPerUserHour: env.ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR,
      transitionPerIpHour: env.ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR,
      maxPhotosPerOrder: env.MAX_ORDER_PHOTOS,
    }),
    conversations: Object.freeze({
      sendPerUserHour: env.MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR,
      sendPerIpHour: env.MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR,
    }),
    notifications: Object.freeze({
      provider: env.PUSH_PROVIDER,
      expoAccessToken: env.EXPO_ACCESS_TOKEN,
      receiptSweepIntervalSeconds: env.PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS,
      receiptMinAgeSeconds: env.PUSH_RECEIPT_MIN_AGE_SECONDS,
      receiptRetentionHours: env.PUSH_RECEIPT_RETENTION_HOURS,
      receiptMaxPerRun: env.PUSH_RECEIPT_MAX_PER_RUN,
    }),
    observability: Object.freeze({
      // The NODE_ENV-dependent default the schema cannot express — see the
      // `LOG_LEVEL` entry above. `debug` is what the process prints today
      // with no logger option at all, so an environment that has not chosen
      // keeps exactly the output it had.
      logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    }),
  });
}
