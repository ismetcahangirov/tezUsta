/**
 * DI token for {@link RateLimitConfig} — the narrowed slice of `AppConfig`
 * this module needs, with `RATE_LIMIT_KEY_SECRET` proven present. An
 * interface cannot be injected by its own type, so this stands in for it
 * (mirrors `infra/config/config.tokens.ts` and `modules/auth/auth.tokens.ts`).
 */
export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

/**
 * DI token for the `AccessTokenSubjectVerifier` `RateLimitGuard` hands to
 * identifier functions (issue #271).
 *
 * Defined here and **provided by `AuthModule`**, the way an interface in a
 * lower layer is implemented by a higher one: the limiter owns the question,
 * authentication owns the answer, and `infra/` never imports `modules/`.
 */
export const ACCESS_TOKEN_SUBJECT_VERIFIER = Symbol('ACCESS_TOKEN_SUBJECT_VERIFIER');
