/**
 * DI token for {@link OtpConfig} — the narrowed slice of `AppConfig` the OTP
 * flow needs, with `OTP_CODE_PEPPER` proven present. An interface cannot be
 * injected by its own type, so this stands in for it (mirrors
 * `modules/auth/auth.tokens.ts` and `infra/rate-limit/rate-limit.tokens.ts`).
 */
export const OTP_CONFIG = Symbol('OTP_CONFIG');
