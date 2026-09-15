/**
 * DI token for the Drizzle database client (a `NodePgDatabase` over the `pg`
 * pool `DatabaseModule` owns). `AppConfig` is an interface, not a class, and
 * Drizzle's return type is generic — neither can be injected by type alone,
 * so every consumer asks for this token instead
 * (mirrors `infra/config/config.tokens.ts`'s `APP_CONFIG`).
 */
export const DATABASE_CONNECTION = Symbol('DATABASE_CONNECTION');
