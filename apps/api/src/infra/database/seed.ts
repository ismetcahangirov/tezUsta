import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadAppConfig } from '../config/load-app-config';
import * as schema from './schema';
import { seedServiceCatalogue } from './seed/seed-service-catalogue';

/**
 * Writes the launch catalogue into a database that has already been migrated.
 *
 * Separate from `migrate.ts` on purpose. A migration changes the *shape* of the
 * database and must run exactly once per version; seed data fills a *new*
 * database and must be skippable on an existing one. Putting the catalogue
 * INTO a migration is the tempting shortcut and it is wrong twice: the rows
 * become unrevisable without a second migration, and an admin's later edit to
 * a price silently diverges from a migration file that still claims otherwise.
 *
 * Exported separately from the CLI entrypoint below so integration tests
 * exercise the same path against a throwaway database.
 */
export async function runSeed(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool, { schema });
    const result = await seedServiceCatalogue(db);
    process.stdout.write(
      `Service catalogue: ${String(result.categoriesInserted)} categories, ` +
        `${String(result.servicesInserted)} services inserted.\n`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * CLI entrypoint: `node dist/infra/database/seed.js` — see the `db:seed`
 * package.json script. Run after `db:migrate`, never from application boot,
 * for the reason spelled out in `migrate.ts`.
 */
if (require.main === module) {
  const config = loadAppConfig();

  runSeed(config.database.url)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
