import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

describe('the hand-written first migration (CREATE EXTENSION postgis)', () => {
  // A fresh throwaway database per test, not per file: each test's name
  // makes a claim about a specific database history ("fresh", "already
  // migrated once") and sharing one database across tests would make that
  // claim depend on execution order instead of being true by construction.
  let database: ThrowawayDatabase;

  beforeEach(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
  });

  afterEach(async () => {
    await database.drop();
  });

  it('applies cleanly to a fresh, empty database', async () => {
    await expect(runMigrations(database.url)).resolves.toBeUndefined();

    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const bookkeeping = await client.query<{ hash: string }>(
        'SELECT hash FROM drizzle.__drizzle_migrations',
      );
      expect(bookkeeping.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

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
  });

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
  });
});
