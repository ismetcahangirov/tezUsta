/**
 * DI token for the `ioredis` client `RedisModule` owns. `AppConfig` is an
 * interface and the client's constructor type is a vendor type, so neither
 * can be injected by type alone (mirrors `infra/database/database.tokens.ts`
 * and `infra/config/config.tokens.ts`).
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * DI token for the SECOND `ioredis` client — the one BullMQ is given.
 *
 * It exists because BullMQ cannot use {@link REDIS_CLIENT}: a `Worker`
 * throws at construction on a connection whose `maxRetriesPerRequest` is set,
 * and `REDIS_CLIENT`'s `maxRetriesPerRequest: 1` is load-bearing for
 * `/health/ready`. See `bullmq-connection.provider.ts` and
 * [ADR-0025](../../../../../docs/decisions/ADR-0025-deferred-work-on-bullmq.md).
 */
export const BULLMQ_REDIS_CLIENT = Symbol('BULLMQ_REDIS_CLIENT');
