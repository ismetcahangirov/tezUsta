import { Inject, Logger, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { HealthModule } from '../../modules/health/health.module';
import { ReadinessCheckRegistry } from '../../modules/health/readiness-check.registry';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * Ceiling on the reconnect backoff. The client keeps retrying indefinitely at
 * this interval — it must NEVER stop.
 *
 * An earlier version returned `null` after three attempts, which reads like
 * "fail fast" but is not: `null` tells ioredis to give up permanently.
 * `event_handler.js` turns it into `close()`, which sets status `end`, and
 * `Redis.js` only re-enters `connect()` from status `wait` — `end` never
 * returns to `wait`. With a 200/400/600ms backoff that made roughly 1.2
 * seconds of unreachability fatal. Reproduced: stop Redis for four seconds,
 * start it again, and the client stays `end` and answers every command with
 * "Connection is closed" forever. Redis recovers; the process does not.
 * `/health/ready` then reports redis down permanently while `/health/live`
 * (which deliberately checks nothing) keeps the pod alive, so an orchestrator
 * pulls it from rotation and never restarts it — a human has to.
 *
 * Fast failure for a single COMMAND is what `maxRetriesPerRequest` and the
 * health check's own 2s timeout provide. That is a different concern from
 * whether the connection is ever re-established, and conflating the two
 * traded availability for nothing.
 */
const RECONNECT_BACKOFF_CEILING_MS = 2000;

/**
 * Exported so a test can assert the property that matters — it returns a
 * number for EVERY attempt and never `null` — without restarting the shared
 * Redis container and making every other suite flaky.
 */
export function redisRetryStrategy(attempt: number): number {
  return Math.min(attempt * 200, RECONNECT_BACKOFF_CEILING_MS);
}

/**
 * Owns the single `ioredis` client for the process, built from
 * `config.redis.url` (never `process.env` — issue #23's `ConfigModule` is the
 * only reader). Registers a `redis` readiness check via the exported
 * `ReadinessCheckRegistry` from its own `onModuleInit`, the same pattern
 * `DatabaseModule` uses — `HealthModule`/`HealthService` are never edited.
 */
const logger = new Logger('RedisModule');

@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const client = new Redis(config.redis.url, {
          // A command whose connection is down retries at most this many
          // times before rejecting, instead of ioredis's default of 20 —
          // see docs/architecture/realtime-architecture.md § Presence: the
          // readiness probe must never hang behind a queued command.
          maxRetriesPerRequest: 1,
          // Never returns `null`: the client must keep trying so it recovers
          // on its own when Redis comes back. See the constant above.
          retryStrategy: redisRetryStrategy,
        });

        // Without a listener ioredis falls back to a raw
        // `console.error('[ioredis] Unhandled error event:', error.stack)`,
        // which bypasses the Nest logger and LOG_LEVEL and prints a stack
        // trace to stderr. Route it through the logger instead, and log the
        // message rather than the stack — a connection error can carry the
        // host and port.
        client.on('error', (error: Error) => {
          logger.error(`Redis connection error, will keep retrying: ${error.message}`);
        });

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    private readonly registry: ReadinessCheckRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'redis',
      check: async () => {
        await this.client.ping();
      },
    });
  }

  /**
   * `disconnect()`, not `quit()`: `quit()` sends a QUIT command and waits for
   * the reply, which hangs shutdown when Redis is already unreachable.
   * `disconnect()` closes the socket immediately without waiting.
   */
  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
