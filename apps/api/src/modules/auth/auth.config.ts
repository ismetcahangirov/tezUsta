import { parseDurationMs, parseDurationSeconds } from '../../common/time/parse-duration';
import type { AppConfig } from '../../infra/config/app-config.types';

/**
 * The auth module's own configuration, with the two secrets **proven present**
 * rather than typed `string | undefined`.
 *
 * `AppConfig.auth.jwtAccessSecret` is optional because EPIC 1 shipped before
 * anything signed a token, and `app-config.types.ts` states the rule that
 * follows from that: "the module that first needs the value is responsible for
 * failing its own startup with a clear error if it is still missing when that
 * Epic lands." This is that module, and {@link createAuthConfig} is that
 * failure.
 */
export interface AuthConfig {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  /** Seconds, because that is the unit of a JWT `exp` claim. */
  readonly accessTtlSeconds: number;
  /** Milliseconds, because that is what `Date` arithmetic wants. */
  readonly refreshTtlMs: number;
  /**
   * How long after a refresh token is spent a second presentation of it is
   * still treated as the same client retrying, rather than as theft
   * (issue #26). Zero makes a dropped response a sign-out.
   */
  readonly refreshReuseGraceMs: number;
}

/**
 * Thrown from the provider factory, so it surfaces during
 * `NestFactory.create` and `main.ts` turns it into a clear message plus a
 * non-zero exit — the same fail-fast path a malformed `DATABASE_URL` takes.
 *
 * A server that boots without a signing secret and fails on the first sign-in
 * has turned a deployment error into a production incident
 * (`docs/architecture/backend-architecture.md` § Configuration).
 */
export class MissingAuthSecretError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not set. The API cannot issue or verify tokens without it — ` +
        'generate one with `openssl rand -base64 48` and set it in the environment ' +
        '(see .env.example). JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ.',
    );
    this.name = 'MissingAuthSecretError';
    Object.setPrototypeOf(this, MissingAuthSecretError.prototype);
  }
}

export function createAuthConfig(config: AppConfig): AuthConfig {
  const { jwtAccessSecret, jwtRefreshSecret, jwtAccessTtl, jwtRefreshTtl } = config.auth;

  // Named individually rather than in one combined check, so the message
  // tells an operator which variable to go and set.
  if (jwtAccessSecret === undefined) {
    throw new MissingAuthSecretError('JWT_ACCESS_SECRET');
  }
  if (jwtRefreshSecret === undefined) {
    throw new MissingAuthSecretError('JWT_REFRESH_SECRET');
  }

  // Length, character set and "the two must differ" are already enforced by
  // `env.schema.ts`; this function only decides presence.
  return Object.freeze({
    accessSecret: jwtAccessSecret,
    refreshSecret: jwtRefreshSecret,
    accessTtlSeconds: parseDurationSeconds(jwtAccessTtl),
    refreshTtlMs: parseDurationMs(jwtRefreshTtl),
    refreshReuseGraceMs: config.auth.refreshReuseGraceSeconds * 1000,
  });
}
