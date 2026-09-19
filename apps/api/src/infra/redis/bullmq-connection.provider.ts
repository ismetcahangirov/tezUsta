import { Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { redisRetryStrategy } from './redis.module';
import { BULLMQ_REDIS_CLIENT } from './redis.tokens';

const logger = new Logger('BullmqConnection');

/**
 * Builds the dedicated `ioredis` client BullMQ is handed.
 *
 * **Why a second connection at all.** `REDIS_CLIENT` sets
 * `maxRetriesPerRequest: 1` so a queued command can never outlive the
 * readiness probe's 2s budget, and `redis.module.ts` spends a paragraph on
 * why that matters. BullMQ refuses that option outright, and not as a
 * warning: with `bullmq@6.3.7` and `ioredis@6.0.0`, constructing a `Worker`
 * on such a client throws
 *
 *     Error: BullMQ: Your redis options maxRetriesPerRequest must be null.
 *
 * before the worker exists — verified by running it against the local Redis,
 * not inferred from the source. The path is
 * `worker.js` → `utils/create-backend.js#createBlockingConnection`, which
 * calls `.duplicate()` on the client it is given, → `redis-connection.js`,
 * whose `checkBlockingOptions` throws (its `throwError` argument is `true` on
 * that path) because the duplicate carried the option across. A `Queue` on the same
 * client is unaffected: it is not a blocking connection, so the same check
 * never fires. `bullmq-connection.test.ts` pins both halves.
 *
 * The requirement is real rather than pedantic. BullMQ's fetch is a blocking
 * `BZPOPMIN` that legitimately sits on the socket for seconds at a time; a
 * client that gives up on a command after one retry would abandon it.
 *
 * So the two clients differ in exactly one option, and each is right for its
 * own job. Everything else — the URL, and the retry strategy that must never
 * return `null` — is shared with `REDIS_CLIENT` deliberately: the reasoning
 * in `redis.module.ts` about a client that stops reconnecting applies here
 * word for word, and a worker that stops reconnecting is worse, because
 * nothing reports it until an order quietly never reaches `NO_MASTER_FOUND`.
 *
 * Budget: three Redis connections per API replica — this one, the shared
 * `REDIS_CLIENT`, and the blocking duplicate BullMQ makes for the worker.
 */
export function createBullmqRedisClient(url: string): Redis {
  const client = new Redis(url, {
    // Required by BullMQ — see above. NOT a relaxation of the fail-fast
    // policy `REDIS_CLIENT` applies: nothing serves an HTTP request from this
    // client, so no probe or handler can queue behind it.
    maxRetriesPerRequest: null,
    // Shared with REDIS_CLIENT on purpose: never returns `null`, so the
    // connection recovers on its own when Redis comes back.
    retryStrategy: redisRetryStrategy,
  });

  // Same reason as `redis.module.ts`: without a listener ioredis writes a raw
  // stack trace to stderr, bypassing the Nest logger and LOG_LEVEL. Log the
  // message only — a connection error can carry the host and port.
  client.on('error', (error: Error) => {
    logger.error(`BullMQ Redis connection error, will keep retrying: ${error.message}`);
  });

  return client;
}

/**
 * The provider, defined here rather than in `queue.module.ts`, so that every
 * decision about how this process talks to Redis lives in `infra/redis/`.
 * Its lifecycle does not: `QueueModule` lists this provider and is what
 * disconnects the client, because the client must outlive the worker's drain
 * (see `queue.module.ts#onModuleDestroy`).
 */
export const bullmqRedisClientProvider: Provider = {
  provide: BULLMQ_REDIS_CLIENT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Redis => createBullmqRedisClient(config.redis.url),
};
