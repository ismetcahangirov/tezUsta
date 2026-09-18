import { parseDurationMs, parseDurationSeconds } from '../../common/time/parse-duration';
import type { AppConfig } from '../../infra/config/app-config.types';

/**
 * The admin path's own configuration, with its secret **proven present**
 * rather than typed `string | undefined` — the same construction
 * `createAuthConfig` and `createOtpConfig` use, so an operator meets one shape
 * of startup error rather than three.
 */
export interface AdminAuthConfig {
  /**
   * Its own signing secret, never the consumer one.
   *
   * [ADR-0014](docs/decisions/ADR-0014-admin-authentication.md) separates the
   * two token families by issuer and audience; a shared secret would mean a
   * bug in either verifier is a total crossover, and it would make the admin
   * key unrotatable without signing every customer out.
   */
  readonly accessSecret: string;
  /** Seconds, because that is the unit of a JWT `exp` claim. */
  readonly accessTtlSeconds: number;
  /** Milliseconds. ADR-0014: an admin session family lives 8 hours. */
  readonly sessionTtlMs: number;
  /**
   * Milliseconds of inactivity after which a session stops working.
   *
   * ADR-0014 gives the admin path a 30-minute idle timeout and the consumer
   * path none, and the asymmetry is the point: an admin console left open on
   * an unattended laptop is a different risk from a phone in a pocket.
   */
  readonly idleTimeoutMs: number;
}

/**
 * Thrown from the provider factory so it surfaces during
 * `NestFactory.create`, which is where a missing signing secret belongs — a
 * server that boots without one and fails on the first admin request has
 * turned a deployment error into an incident.
 */
export class MissingAdminSecretError extends Error {
  constructor() {
    super(
      'JWT_ADMIN_ACCESS_SECRET is not set. Admin tokens are signed with their own key, ' +
        'separate from the consumer path (ADR-0014) — generate one with ' +
        '`openssl rand -base64 48` and set it in the environment (see .env.example). ' +
        'It must differ from every other signing secret.',
    );
    this.name = 'MissingAdminSecretError';
    Object.setPrototypeOf(this, MissingAdminSecretError.prototype);
  }
}

export function createAdminAuthConfig(config: AppConfig): AdminAuthConfig {
  const { accessSecret, accessTtl, sessionTtl, idleTimeout } = config.admin;

  if (accessSecret === undefined) {
    throw new MissingAdminSecretError();
  }

  return Object.freeze({
    accessSecret,
    accessTtlSeconds: parseDurationSeconds(accessTtl),
    sessionTtlMs: parseDurationMs(sessionTtl),
    idleTimeoutMs: parseDurationMs(idleTimeout),
  });
}
