import { Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { HealthModule } from '../../modules/health/health.module';
import { ReadinessCheckRegistry } from '../../modules/health/readiness-check.registry';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * Reconnect attempts before ioredis gives up on a connection. Bounded (not
 * `Infinity`/`null`, ioredis's own default retry-forever shape) so a dead
 * Redis fails fast: without a ceiling, a black-holed connection would retry
 * forever, its offline queue would grow unbounded, and every readiness PING
 * would sit in that queue until the health check's own 2s timeout fires
 * instead of the client itself ever reporting "down".
 */
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Owns the single `ioredis` client for the process, built from
 * `config.redis.url` (never `process.env` — issue #23's `ConfigModule` is the
 * only reader). Registers a `redis` readiness check via the exported
 * `ReadinessCheckRegistry` from its own `onModuleInit`, the same pattern
 * `DatabaseModule` uses — `HealthModule`/`HealthService` are never edited.
 */
@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis =>
        new Redis(config.redis.url, {
          // A command whose connection is down retries at most this many
          // times before rejecting, instead of ioredis's default of 20 —
          // see docs/architecture/realtime-architecture.md § Presence: the
          // readiness probe must never hang behind a queued command.
          maxRetriesPerRequest: 1,
          // Stops reconnecting after MAX_RECONNECT_ATTEMPTS (returning
          // `null` tells ioredis to give up) rather than backing off forever.
          retryStrategy: (attempt) =>
            attempt > MAX_RECONNECT_ATTEMPTS ? null : Math.min(attempt * 200, 2000),
        }),
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
