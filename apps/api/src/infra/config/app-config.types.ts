/**
 * The API's fully validated runtime configuration — the typed shape every
 * module receives via the {@link APP_CONFIG} injection token instead of
 * touching `process.env` directly
 * (`docs/architecture/backend-architecture.md` § Configuration,
 * `docs/engineering/security.md` § Environment validation).
 *
 * Grouped by domain, matching `.env.example`'s sections, rather than one flat
 * bag. Lives here while `apps/api` is its only consumer and moves to
 * `packages/config` on the second consumer
 * (ADR-0016-shared-package-timing.md) — the shape below carries no Nest,
 * Fastify, or Zod type, so that move is a file move.
 *
 * A field typed `string | undefined` is a variable this repository has
 * decided NOT to require yet — see CLAUDE.md §1 "Decisions still open". Each
 * carries a comment naming the Epic that will make it required; the module
 * that first needs the value is responsible for failing its own startup with
 * a clear error if it is still missing when that Epic lands.
 */
export interface AppConfig {
  readonly runtime: {
    readonly nodeEnv: 'development' | 'test' | 'production';
    readonly port: number;
    readonly host: string;
    /**
     * Parsed and validated, but **not applied yet** — nothing calls
     * `app.enableCors()`. `.env.example` ships a value, so an operator could
     * reasonably read this as "CORS is enforced"; it is not. The first browser
     * client is `apps/admin` (EPIC 13), and that is where it gets wired.
     */
    readonly corsOrigins: readonly string[];
  };

  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };

  readonly redis: {
    readonly url: string;
  };

  readonly auth: {
    /** Required by EPIC 2 (real sign-in). */
    readonly jwtAccessSecret: string | undefined;
    /** Required by EPIC 2 (real sign-in). */
    readonly jwtRefreshSecret: string | undefined;
    /**
     * Always present — 15 minutes by default, per
     * `docs/architecture/authentication.md` § Token model. Unlike the two
     * secrets above, a missing TTL has a single correct answer, so the schema
     * defaults it rather than making the module fail.
     */
    readonly jwtAccessTtl: string;
    /** Always present — 30 days by default. See {@link jwtAccessTtl}. */
    readonly jwtRefreshTtl: string;
    /**
     * Seconds after a refresh token is spent during which presenting it again
     * is read as the same client retrying a lost response, not as theft
     * (issue #26). Zero disables the retry path.
     */
    readonly refreshReuseGraceSeconds: number;
  };

  /**
   * Redis-backed rate limiting on the authentication surface (issue #28,
   * ADR-0008 § Security requirements).
   *
   * The OTP budgets are **not** here — they live under {@link sms}.`otp`,
   * where `.env.example` has grouped them since EPIC 1 and where ADR-0008
   * describes them. Splitting a concern across two config groups is a wart,
   * accepted over renaming environment variables that are already documented:
   * a renamed variable does not fail, it silently falls back to its default,
   * and the default of a financial control is not a thing to reintroduce by
   * accident. `infra/rate-limit/rate-limit.config.ts` reads both groups and
   * is the one place that has to know.
   */
  readonly rateLimit: {
    /**
     * Required by EPIC 2 — `RateLimitModule` fails its own startup without
     * it, the same way `AuthModule` does for the JWT secrets. It is the HMAC
     * pepper that keeps phone numbers out of the Redis key space; see
     * `rate-limit.config.ts` for why a bare hash is not enough.
     */
    readonly keySecret: string | undefined;
    readonly signInPerIdentifierHour: number;
    readonly signInPerIpHour: number;
    readonly refreshPerSessionHour: number;
    readonly refreshPerIpHour: number;
    /** How many windows of backoff a persistently over-limit caller can accrue. */
    readonly backoffMultiplier: number;
    /**
     * `GET /services/:id/price-range` (issue #84) — not authentication and not
     * a paid third-party call, but the only budget standing between an
     * unauthenticated, uncached, live-computed join-plus-aggregate and
     * `master_services` (`infra/rate-limit/rate-limit.config.ts`).
     */
    readonly priceRangePerUserHour: number;
    readonly priceRangePerIpHour: number;
  };

  readonly admin: {
    /**
     * Required by the admin surface — `AdminModule` fails its own startup
     * without it, the same way `AuthModule` does for the JWT secrets. Its own
     * key, never the consumer one (ADR-0014).
     */
    readonly accessSecret: string | undefined;
    /** `ms`-style shorthand, e.g. `15m`. */
    readonly accessTtl: string;
    /** ADR-0014: 8 hours. */
    readonly sessionTtl: string;
    /** ADR-0014: 30 minutes of inactivity. The consumer path has no equivalent. */
    readonly idleTimeout: string;
  };

  readonly storage: {
    /** Which {@link StorageProvider} implementation to construct (ADR-0024). */
    readonly provider: 's3' | 'stub';
    /** Upload-URL lifetime. ADR-0005 caps it at five minutes. */
    readonly presignTtlSeconds: number;
    /** Download-URL lifetime, shorter — nothing waits on a read. */
    readonly downloadTtlSeconds: number;
    /** Hard per-document cap, enforced at confirm against `head()` (ADR-0024). */
    readonly verificationDocumentMaxBytes: number;
    /**
     * Hard per-photo cap for order problem photos (issue #83), enforced the
     * same way. A separate knob from `verificationDocumentMaxBytes` — see
     * `env.schema.ts` § `ORDER_PHOTO_MAX_BYTES`.
     */
    readonly orderPhotoMaxBytes: number;
    /** Presigned upload URLs one master may mint per hour — a bucket is billed. */
    readonly uploadPresignPerUserHour: number;
    readonly uploadPresignPerIpHour: number;
    /** Required by EPIC 5/6 (document + photo upload) once ADR-0005 is decided. */
    readonly s3Endpoint: string | undefined;
    /** Required by EPIC 5/6. */
    readonly s3Region: string | undefined;
    /** Required by EPIC 5/6. */
    readonly s3Bucket: string | undefined;
    /** Required by EPIC 5/6. */
    readonly s3AccessKeyId: string | undefined;
    /** Required by EPIC 5/6. */
    readonly s3SecretAccessKey: string | undefined;
    /** Required by EPIC 5/6. */
    readonly s3PublicBaseUrl: string | undefined;
  };

  readonly maps: {
    readonly provider: 'google' | 'stub';
    /** Required by EPIC 4 (geocoding, nearby-master queries). Billable — never EXPO_PUBLIC_. */
    readonly serverApiKey: string | undefined;
    /** Capped at 30 by Google's Maps Service Specific Terms §6.3.1. */
    readonly geocodeCacheTtlDays: number;
    readonly geocodeLanguage: string;
    readonly geocodeCountry: string;
    readonly geocodeTimeoutMs: number;
    readonly geocodePerUserHour: number;
    readonly geocodePerIpHour: number;
  };

  readonly sms: {
    readonly provider: 'stub';
    /** Required by EPIC 2, once an SMS provider is chosen (CLAUDE.md §1). */
    readonly apiKey: string | undefined;
    /** Required by EPIC 2. */
    readonly senderId: string | undefined;
    readonly otp: {
      /**
       * Required by EPIC 2 — `OtpModule` fails its own startup without it
       * (issue #29), the same way `AuthModule` does for the JWT secrets. It is
       * the HMAC pepper that keeps a stored OTP code from being a usable
       * credential in a database dump; see
       * `modules/auth/otp.config.ts` for why a bare digest is not enough for a
       * six-digit secret.
       */
      readonly codePepper: string | undefined;
      readonly length: number;
      readonly ttlSeconds: number;
      readonly maxAttempts: number;
      readonly rateLimitPerPhoneHour: number;
      readonly rateLimitPerIpHour: number;
    };
  };

  readonly presence: {
    /** Seconds a master stays live with no heartbeat. Three beats' worth. */
    readonly ttlSeconds: number;
    /** How often the app should refresh it. */
    readonly heartbeatSeconds: number;
  };

  /**
   * Master position reporting (issue #98) — the one config group that is a
   * privacy control rather than a performance one.
   */
  readonly masterLocation: {
    /**
     * How long a master's position trail is kept. Enforced on the write path,
     * not by a sweep: `MasterLocationRepository.record` prunes inside the
     * transaction that inserts, because this repository has no scheduler and a
     * retention rule waiting for one that does not exist is not a rule.
     */
    readonly trailMinutes: number;
    /**
     * Position reports one master may send per hour, and per IP. The server is
     * the authority on the reporting interval
     * (`docs/architecture/realtime-architecture.md` § Location update budget);
     * this is where that authority is actually applied.
     */
    readonly reportPerUserHour: number;
    readonly reportPerIpHour: number;
  };

  /**
   * The master's side of dispatch (issue #101).
   *
   * Only a budget so far, because only the budget is a tuning parameter: the
   * offer feed's shape is a contract and the accept guard is a `WHERE` clause,
   * neither of which anybody should be able to change from the environment.
   */
  readonly masterOffers: {
    /**
     * Accepts and declines one master may send per hour, and per IP. What this
     * bounds is neither a bill nor a credential guess: it is a master's app
     * hammering `accept` on every offer in the city, which on a
     * first-accept-wins model (ADR-0009) is how one scripted client takes work
     * away from everybody responding by hand.
     */
    readonly responsePerUserHour: number;
    readonly responsePerIpHour: number;
  };

  readonly dispatch: {
    readonly initialRadiusM: number;
    readonly maxRadiusM: number;
    readonly radiusStepSeconds: number;
    readonly totalTimeoutSeconds: number;
    readonly maxMastersPerBroadcast: number;
    /**
     * How old a master's newest position may be before dispatch treats them as
     * missing rather than as "in range at their last known point"
     * ([ADR-0026](docs/decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
     *
     * **Not the presence TTL.** Presence answers "can we reach this app" and a
     * heartbeat refreshes it without writing a position, so the two windows
     * drift apart for every master who is online and not moving. This one
     * answers "is this position still true", and its default is derived from
     * the reporting floor the location budget guarantees.
     */
    readonly maxPositionAgeSeconds: number;
    readonly maxOrderRedispatches: number;
  };

  /**
   * The deferred-work mechanism — BullMQ delayed jobs on Redis
   * ([ADR-0025](../../../../../docs/decisions/ADR-0025-deferred-work-on-bullmq.md)).
   *
   * Nothing here is a dispatch parameter: the radius step and the give-up
   * deadline live under {@link dispatch}, because they are policy that
   * happens to be expressed as a delay. This group is the transport those
   * delays ride on, and would be identical if dispatch did not exist.
   */
  readonly queue: {
    /** Namespace for every BullMQ key, so two runs against one Redis are isolated. */
    readonly prefix: string;
    /**
     * `in-process` runs the worker inside the API replica — what ships today,
     * and a recorded deviation from `backend-architecture.md` § Background
     * jobs. `off` makes the replica a producer only, which is the flag half
     * of extracting a separate worker deployment later.
     */
    readonly workerMode: 'in-process' | 'off';
    readonly workerConcurrency: number;
    /** Total attempts per job, retries included. 1 disables retrying. */
    readonly jobAttempts: number;
    /** Base delay of the exponential backoff between attempts. */
    readonly jobBackoffMs: number;
  };

  readonly orders: {
    readonly maxCommissionDebtMinor: number;
    readonly disputeWindowHours: number;
    /**
     * Orders one customer may create per hour, and per IP (EPIC 6). Bounds
     * dispatch rather than a bill: every created order rings nearby masters'
     * phones (ADR-0009).
     */
    readonly createPerUserHour: number;
    readonly createPerIpHour: number;
    /**
     * The most problem photos a customer may attach to one order (issue #83).
     * Enforced atomically against `orders.photo_count`, not read-then-write —
     * see `order-photos.repository.ts#attach`.
     */
    readonly maxPhotosPerOrder: number;
  };

  readonly notifications: {
    /** Required by EPIC 10 (push notifications). */
    readonly expoAccessToken: string | undefined;
  };

  readonly observability: {
    /**
     * Parsed and validated, but **not applied yet** — nothing passes it to
     * Nest's logger, so changing `LOG_LEVEL` currently changes nothing. Wire
     * it when structured logging arrives (EPIC 17), or drop the variable.
     */
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}
