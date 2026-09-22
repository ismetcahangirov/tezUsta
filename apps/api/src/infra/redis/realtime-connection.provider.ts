import { Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { redisRetryStrategy } from './redis.module';
import { REALTIME_REDIS_CLIENT } from './redis.tokens';

const logger = new Logger('RealtimeConnection');

/**
 * Builds the dedicated `ioredis` client the socket.io Redis adapter is handed
 * (issue #166).
 *
 * **Why a third connection.** `REDIS_CLIENT` sets `maxRetriesPerRequest: 1` so
 * that no command can outlive the readiness probe's budget, and
 * `redis.module.ts` argues that at length. `@socket.io/redis-streams-adapter`
 * does two things that make it the wrong client to hand over:
 *
 * - it polls with `XREAD ... BLOCK 5000`, a command that is *supposed* to sit
 *   on the socket for seconds at a time, and
 * - it builds every client it needs by calling `.duplicate()` on the one it is
 *   given (`dist/util.js#duplicateClient`), which copies the options across.
 *
 * So `maxRetriesPerRequest: 1` would reach the blocking reader, the poll would
 * be abandoned, and the instance would quietly stop receiving anything
 * published by its peers — the exact silent failure the adapter exists to
 * prevent. This is the same reasoning, and the same shape, as
 * `bullmq-connection.provider.ts`
 * ([ADR-0025](../../../../../docs/decisions/ADR-0025-deferred-work-on-bullmq.md)).
 *
 * Everything else is shared with `REDIS_CLIENT` on purpose, the retry strategy
 * above all: a realtime client that stops reconnecting is worse than one that
 * never connected, because every instance keeps serving sockets and simply
 * stops agreeing with the others about what happened.
 *
 * Budget: this client plus the duplicates the adapter makes from it — one
 * reader per stream (one, at `streamCount: 1`) and one subscriber.
 */
export function createRealtimeRedisClient(url: string): Redis {
  const client = new Redis(url, {
    // Required by the blocking reader — see above. NOT a relaxation of the
    // fail-fast policy `REDIS_CLIENT` applies: nothing serves an HTTP request
    // from this client, so no probe or handler can queue behind it.
    maxRetriesPerRequest: null,
    retryStrategy: redisRetryStrategy,
  });

  // Same reason as `redis.module.ts`: without a listener ioredis writes a raw
  // stack trace to stderr, bypassing the Nest logger and LOG_LEVEL. Log the
  // message only — a connection error can carry the host and port.
  client.on('error', (error: Error) => {
    logger.error(`Realtime Redis connection error, will keep retrying: ${error.message}`);
  });

  return client;
}

/**
 * Defined here rather than in `realtime.module.ts`, so that every decision
 * about how this process talks to Redis lives in `infra/redis/` — the same
 * split `bullmq-connection.provider.ts` uses. `RealtimeModule` owns the
 * lifecycle.
 */
export const realtimeRedisClientProvider: Provider = {
  provide: REALTIME_REDIS_CLIENT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Redis => createRealtimeRedisClient(config.redis.url),
};
