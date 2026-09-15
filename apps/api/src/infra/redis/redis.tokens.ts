/**
 * DI token for the `ioredis` client `RedisModule` owns. `AppConfig` is an
 * interface and the client's constructor type is a vendor type, so neither
 * can be injected by type alone (mirrors `infra/database/database.tokens.ts`
 * and `infra/config/config.tokens.ts`).
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
