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
    /** Required by EPIC 2 (real sign-in). */
    readonly jwtAccessTtl: string | undefined;
    /** Required by EPIC 2 (real sign-in). */
    readonly jwtRefreshTtl: string | undefined;
  };

  readonly storage: {
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
    readonly provider: 'google';
    /** Required by EPIC 4 (geocoding, nearby-master queries). Billable — never EXPO_PUBLIC_. */
    readonly serverApiKey: string | undefined;
    readonly geocodeCacheTtlDays: number;
  };

  readonly sms: {
    readonly provider: 'stub';
    /** Required by EPIC 2, once an SMS provider is chosen (CLAUDE.md §1). */
    readonly apiKey: string | undefined;
    /** Required by EPIC 2. */
    readonly senderId: string | undefined;
    readonly otp: {
      readonly length: number;
      readonly ttlSeconds: number;
      readonly maxAttempts: number;
      readonly rateLimitPerPhoneHour: number;
      readonly rateLimitPerIpHour: number;
    };
  };

  readonly dispatch: {
    readonly initialRadiusM: number;
    readonly maxRadiusM: number;
    readonly radiusStepSeconds: number;
    readonly totalTimeoutSeconds: number;
    readonly maxMastersPerBroadcast: number;
    readonly maxOrderRedispatches: number;
  };

  readonly orders: {
    readonly maxCommissionDebtMinor: number;
    readonly disputeWindowHours: number;
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
