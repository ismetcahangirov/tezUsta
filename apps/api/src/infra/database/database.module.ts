import { Inject, Logger, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { HealthModule } from '../../modules/health/health.module';
import { ReadinessCheckRegistry } from '../../modules/health/readiness-check.registry';
import { DATABASE_CONNECTION } from './database.tokens';
import type { Database } from './database.types';
import * as schema from './schema';

/**
 * Owns the single `pg` `Pool` for the whole process and the Drizzle client
 * built over it (ADR-0003). Pool size comes from `config.database.poolMax` —
 * never a hard-coded number — and the connection string from
 * `config.database.url`; both travel through the global `ConfigModule`
 * (issue #23), never `process.env` directly.
 *
 * Registers a `postgres` readiness check with the exported
 * `ReadinessCheckRegistry` from its own `onModuleInit`, exactly the pattern
 * `readiness-check.registry.ts` documents — `HealthModule` and
 * `HealthService` are never edited to know Postgres exists.
 */
const logger = new Logger('DatabaseModule');

@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: DATABASE_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Database => {
        const pool = new Pool({
          connectionString: config.database.url,
          max: config.database.poolMax,
        });

        // NOT optional. `pg-pool` emits 'error' when a POOLED-BUT-IDLE
        // connection breaks, and an EventEmitter with no 'error' listener
        // throws — which terminates the whole process. A Postgres restart,
        // a managed-instance failover, a maintenance window, an
        // `idle_session_timeout`, a DBA `pg_terminate_backend`, or a load
        // balancer reaping an idle socket would each turn "the database
        // blipped" into "this API instance died", taking `enableShutdownHooks`
        // with it so in-flight requests are dropped and `onModuleDestroy`
        // never runs. The readiness probe cannot report that, because there
        // is no process left to answer it.
        //
        // Verified by reproduction: warm the pool, park the client idle,
        // `pg_terminate_backend` it — without this listener the process exits 1.
        // Swallowing is correct here: pg discards the broken client itself and
        // the next checkout opens a fresh connection.
        pool.on('error', (error: Error) => {
          logger.error(`Idle Postgres client errored, connection discarded: ${error.message}`);
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly registry: ReadinessCheckRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'postgres',
      check: async () => {
        await this.db.execute(sql`select 1`);
      },
    });
  }

  /**
   * Closes the pool on shutdown so the process can exit and, in tests, so a
   * `Test.createTestingModule(...)` instance does not leak open sockets
   * between suites. Never runs at request time — only Nest's shutdown
   * lifecycle calls this.
   */
  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end();
  }
}
