import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { loadAppConfig } from '../config/load-app-config';

/**
 * Migrations are plain `.sql` + JSON metadata files (never compiled), so they
 * sit next to this script both in `src/` and in the emitted `dist/` — see
 * `apps/api/nest-cli.json`'s `compilerOptions.assets`, which copies
 * `infra/database/migrations/**` into `dist` on every `nest build` because
 * `tsc` only emits `.ts` sources on its own.
 */
export const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

/**
 * Applies every pending migration in {@link MIGRATIONS_FOLDER} to
 * `databaseUrl`, using Drizzle's own migration bookkeeping (a
 * `drizzle.__drizzle_migrations` table — see the `PgDialect.migrate` source
 * in the installed `drizzle-orm` package) — so re-running this against a
 * database that already has every migration applied is a no-op.
 *
 * Exported separately from this file's CLI entrypoint below so integration
 * tests exercise the exact same migration path against a throwaway database
 * (`test/support/throwaway-database.ts`) instead of re-implementing it.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

/**
 * CLI entrypoint: `node dist/infra/database/migrate.js`, run as its own
 * one-shot process — see the `db:migrate` package.json script.
 *
 * Deliberately NOT called from `main.ts` or any Nest lifecycle hook.
 * CLAUDE.md §12 requires the API to be horizontally scalable, with no
 * in-process state two instances could disagree about; running a migration
 * from application boot breaks that the moment there are two instances,
 * because both would race to apply the same migration against the same
 * database at startup. A rolling deploy makes this worse, not better: the OLD
 * and NEW versions are briefly live together, so an autoboot migration can
 * fire from a process that is about to be replaced. Migrations run as a
 * separate, explicit, single-invocation step in the deploy pipeline instead —
 * do not "fix" this by wiring it back into bootstrap.
 *
 * `require.main === module` — not an ES module `import.meta` check — because
 * `tsconfig.build.json` emits CommonJS (no `"type": "module"` in
 * `package.json`; see `dist/main.js`), so this file only runs its CLI branch
 * when executed directly, never when `runMigrations` above is imported.
 */
if (require.main === module) {
  const config = loadAppConfig();

  runMigrations(config.database.url)
    .then(() => {
      process.stdout.write('Migrations applied.\n');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
