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

/**
 * DI token for the THIRD `ioredis` client — the one the socket.io Redis
 * adapter is handed (issue #166).
 *
 * It exists for the same reason {@link BULLMQ_REDIS_CLIENT} does, arrived at
 * from the shipped adapter rather than from its documentation. The streams
 * adapter reads with a blocking `XREAD ... BLOCK 5000` and builds its own
 * clients by calling `.duplicate()` on whatever it is given — and
 * `.duplicate()` carries the source client's options across. Handing it
 * {@link REDIS_CLIENT}, whose `maxRetriesPerRequest: 1` is load-bearing for
 * `/health/ready`, would therefore put that limit on a blocking read: the
 * poll would be abandoned after one retry and the instance would stop
 * receiving events, with nothing in the logs saying so.
 *
 * See `realtime-connection.provider.ts`.
 */
export const REALTIME_REDIS_CLIENT = Symbol('REALTIME_REDIS_CLIENT');
