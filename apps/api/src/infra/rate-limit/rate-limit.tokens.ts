/**
 * DI token for {@link RateLimitConfig} — the narrowed slice of `AppConfig`
 * this module needs, with `RATE_LIMIT_KEY_SECRET` proven present. An
 * interface cannot be injected by its own type, so this stands in for it
 * (mirrors `infra/config/config.tokens.ts` and `modules/auth/auth.tokens.ts`).
 */
export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');
