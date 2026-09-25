import type { AppConfig } from '../../infra/config/app-config.types';

/**
 * The OTP flow's own configuration, with the pepper **proven present** rather
 * than typed `string | undefined`.
 *
 * `AppConfig.sms.otp.codePepper` is optional because EPIC 1 shipped before
 * anything issued a code, and `app-config.types.ts` states the rule that
 * follows: "the module that first needs the value is responsible for failing
 * its own startup with a clear error if it is still missing." This is that
 * module, and {@link createOtpConfig} is that failure — mirroring
 * `createAuthConfig` and `createRateLimitConfig` exactly, so an operator meets
 * one shape of startup error rather than three.
 *
 * The three policy numbers are copied out of `AppConfig` rather than read
 * through it at call time so that the service depends on four values, not on
 * the whole configuration tree — which is what will make the later move of
 * this folder's config to `packages/config` (ADR-0016) a file move.
 */
export interface OtpConfig {
  /** HMAC key for the stored code digest. See {@link MissingOtpCodePepperError}. */
  readonly codePepper: string;
  /** Digits per code. 6 by ADR-0008; `env.schema.ts` refuses anything below it. */
  readonly length: number;
  /** Milliseconds, because that is what `Date` arithmetic wants. */
  readonly ttlMs: number;
  /** Wrong guesses allowed against one code before it is invalidated. */
  readonly maxAttempts: number;
  /**
   * Platform-wide OTP sends permitted per rolling 24h window (issue #272).
   * `env.schema.ts` bounds and defaults it; `OtpService.request` is what
   * refuses once it is spent.
   */
  readonly globalDailyCap: number;
}

/**
 * Thrown from the provider factory, so it surfaces during
 * `NestFactory.create` and `main.ts` turns it into a clear message plus a
 * non-zero exit — the same fail-fast path `MissingAuthSecretError` and
 * `MissingRateLimitKeySecretError` take.
 *
 * Booting without the pepper is not an option worth having, and the tempting
 * alternatives are both worse than stopping. Hashing unkeyed would leave the
 * service working perfectly while every stored code became recoverable from a
 * dump by enumerating 10^6 candidates — a downgrade with nothing in the logs
 * to announce it. Generating a pepper per process would give every instance a
 * different one, so a code requested on pod A could never be verified on pod
 * B, and sign-in would fail for a fraction of users that changes with the
 * replica count.
 */
export class MissingOtpCodePepperError extends Error {
  constructor() {
    super(
      'OTP_CODE_PEPPER is not set. Every OTP code is HMAC-SHA256 hashed under this ' +
        'pepper before it is stored, because a six-digit code hashed WITHOUT a key is ' +
        'recoverable from a database dump in milliseconds — generate one with ' +
        '`openssl rand -base64 48` and set it in the environment (see .env.example). ' +
        'It must differ from JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and RATE_LIMIT_KEY_SECRET.',
    );
    this.name = 'MissingOtpCodePepperError';
    Object.setPrototypeOf(this, MissingOtpCodePepperError.prototype);
  }
}

export function createOtpConfig(config: AppConfig): OtpConfig {
  const { codePepper, length, ttlSeconds, maxAttempts, globalDailyCap } = config.sms.otp;

  if (codePepper === undefined) {
    throw new MissingOtpCodePepperError();
  }

  // Length, character set, the placeholder check, the "must differ" rule and
  // the ranges on the four numbers are all enforced by `env.schema.ts`; this
  // function only decides presence, exactly like `createAuthConfig`.
  return Object.freeze({
    codePepper,
    length,
    ttlMs: ttlSeconds * 1000,
    maxAttempts,
    globalDailyCap,
  });
}
