import { Module } from '@nestjs/common';

import { bullmqRedisClientProvider } from './bullmq-connection.provider';
import { BULLMQ_REDIS_CLIENT } from './redis.tokens';

/**
 * Owns nothing but the second `ioredis` client — the one BullMQ is handed.
 *
 * Separate from {@link RedisModule} rather than a second provider inside it,
 * for two reasons.
 *
 * 1. **Cost.** Nest instantiates every provider of an imported module, so
 *    adding this to `RedisModule` would open a second Redis connection in
 *    every process that imports it for the cache, presence or rate limiting —
 *    including every integration test — whether or not a queue exists.
 * 2. **Lifecycle.** `RedisModule` disconnects its client in `onModuleDestroy`.
 *    This one must NOT: it has to outlive the worker's drain, which happens in
 *    `QueueModule.onModuleDestroy`. Keeping the two clients in one module
 *    would put two contradictory shutdown rules in one hook.
 *
 * There is deliberately no `onModuleDestroy` here. `QueueModule` disconnects
 * this client, immediately after draining the worker that depends on it.
 */
@Module({
  providers: [bullmqRedisClientProvider],
  exports: [BULLMQ_REDIS_CLIENT],
})
export class BullmqConnectionModule {}
