import { Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { HealthModule } from '../../modules/health/health.module';
import { ReadinessCheckRegistry } from '../../modules/health/readiness-check.registry';
import { DATABASE_CONNECTION } from './database.tokens';
import * as schema from './schema';

// `drizzle(pool, ...)` returns `NodePgDatabase<TSchema> & { $client: Pool }` —
// the plain `NodePgDatabase<TSchema>` alone (what `drizzle-orm/node-postgres`
// exports as a standalone type) drops that intersection member, so it is
// spelled out here to keep `$client` (used only for shutdown, below) typed.
type Database = NodePgDatabase<typeof schema> & { $client: Pool };

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
