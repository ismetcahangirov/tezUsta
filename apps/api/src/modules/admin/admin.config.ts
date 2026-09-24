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
  /** The 32-byte AES-256-GCM key stored TOTP secrets are sealed under (ADR-0043 § 2). */
  readonly totpEncryptionKey: Buffer;
  /** Where `apps/admin` is served — the base of every setup link. */
  readonly setupLinkBaseUrl: string;
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

/** The same fail-at-boot argument as `MissingAdminSecretError`. */
export class MissingAdminTotpKeyError extends Error {
  constructor() {
    super(
      'ADMIN_TOTP_ENCRYPTION_KEY is not set. Admin TOTP secrets are encrypted at rest ' +
        '(ADR-0043) — generate a key with `openssl rand -base64 32` and set it in the ' +
        'environment (see .env.example).',
    );
    this.name = 'MissingAdminTotpKeyError';
    Object.setPrototypeOf(this, MissingAdminTotpKeyError.prototype);
  }
}

/**
 * A setup link is a credential: over plain http it is readable by anyone on
 * the path. Checked when the admin surface starts rather than in the env
 * schema, so a production process that never serves admins is not refused
 * over a URL it will never print.
 */
export class InsecureAdminSetupLinkError extends Error {
  constructor() {
    super('ADMIN_SETUP_LINK_BASE_URL must be an https URL under NODE_ENV=production (ADR-0043).');
    this.name = 'InsecureAdminSetupLinkError';
    Object.setPrototypeOf(this, InsecureAdminSetupLinkError.prototype);
  }
}

export function createAdminAuthConfig(config: AppConfig): AdminAuthConfig {
  const { accessSecret, accessTtl, sessionTtl, idleTimeout, totpEncryptionKey, setupLinkBaseUrl } =
    config.admin;

  if (accessSecret === undefined) {
    throw new MissingAdminSecretError();
  }
  if (totpEncryptionKey === undefined) {
    throw new MissingAdminTotpKeyError();
  }
  if (config.runtime.nodeEnv === 'production' && !setupLinkBaseUrl.startsWith('https://')) {
    throw new InsecureAdminSetupLinkError();
  }

  return Object.freeze({
    accessSecret,
    accessTtlSeconds: parseDurationSeconds(accessTtl),
    sessionTtlMs: parseDurationMs(sessionTtl),
    idleTimeoutMs: parseDurationMs(idleTimeout),
    totpEncryptionKey: Buffer.from(totpEncryptionKey, 'base64'),
    setupLinkBaseUrl: setupLinkBaseUrl.replace(/\/+$/, ''),
  });
}
