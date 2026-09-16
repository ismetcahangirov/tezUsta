/**
 * DI token for {@link AuthConfig} — the narrowed, already-proven-present slice
 * of `AppConfig` that the auth module needs. An interface cannot be injected
 * by its own type, so this stands in for it (mirrors
 * `infra/config/config.tokens.ts`).
 */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
