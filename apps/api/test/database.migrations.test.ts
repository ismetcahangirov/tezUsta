import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/infra/database/migrate';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * How many migrations the tree currently contains, read from Drizzle's own
 * journal rather than written as a literal.
 *
 * A literal here is a trap with a delay: it passes for as long as there is one
 * migration and fails on the day somebody adds the second, in a test whose name
 * makes no claim about how many there are. (EPIC 2's `0001_auth_identity_and_
 * sessions` is exactly when that happened.) The claim being asserted is "every
 * migration in the tree was applied, and applied once" — so the expected count
 * has to come from the tree.
 */
function migrationCount(): number {
  const journal: unknown = JSON.parse(
    readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  );
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('entries' in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error('Drizzle migration journal is not the expected shape.');
  }
  return journal.entries.length;
}

/*
 * The 60-second budget on every hook and test below is not decoration.
 *
 * Each one creates a throwaway database, enables PostGIS, and applies the whole
 * migration tree from empty — work that grows with every migration added, run
 * while the rest of the suite competes for the same Postgres. Vitest's default
 * 5 s was already marginal and `order_offers` is simply the migration that
 * crossed the line: this file passes in isolation and times out under the full
 * suite, which is the signature of a budget, not of a defect.
 *
 * A generous ceiling rather than a tuned one. It exists to catch a migration
 * that genuinely hangs, not to police how long an honest one takes.
 */

describe('the migration pipeline (PostGIS extension + the generated schema)', () => {
  // A fresh throwaway database per test, not per file: each test's name
  // makes a claim about a specific database history ("fresh", "already
  // migrated once") and sharing one database across tests would make that
  // claim depend on execution order instead of being true by construction.
  let database: ThrowawayDatabase;

  beforeEach(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
  }, 60_000);

  afterEach(async () => {
    await database.drop();
  }, 60_000);

  it('applies cleanly to a fresh, empty database', async () => {
    await expect(runMigrations(database.url)).resolves.toBeUndefined();

    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const bookkeeping = await client.query<{ hash: string }>(
        'SELECT hash FROM drizzle.__drizzle_migrations',
      );
      expect(bookkeeping.rows).toHaveLength(migrationCount());
    } finally {
      await client.end();
    }
  }, 60_000);

  it('is a no-op the second time it runs against the same database', async () => {
    await runMigrations(database.url); // first application

    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const before = await client.query<{ hash: string; created_at: string }>(
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
      );

      // Second application must not error and must not add or change a row.
      await expect(runMigrations(database.url)).resolves.toBeUndefined();

      const after = await client.query<{ hash: string; created_at: string }>(
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
      );
      expect(after.rows).toEqual(before.rows);

      // The extension itself is also unaffected by re-running (the
      // migration's own `IF NOT EXISTS` makes this doubly safe).
      const extension = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'postgis'",
      );
      expect(extension.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  }, 60_000);

  it('installs a callable PostGIS after migrating', async () => {
    await runMigrations(database.url);

    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const result = await client.query<{ postgis_version: string }>('SELECT PostGIS_Version()');
      expect(result.rows[0]?.postgis_version).toEqual(expect.any(String));
      expect(result.rows[0]?.postgis_version.length ?? 0).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});
