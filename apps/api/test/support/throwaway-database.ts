import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

/**
 * Why not `testcontainers` (CLAUDE.md §10 — dependency policy): CI already
 * runs a real `postgis/postgis:17-3.5` service container for this job
 * (`.github/workflows/ci.yml`), and local development brings up the same
 * image via `docker-compose.yml`. Adding `testcontainers` would mean
 * launching Postgres a SECOND time inside a container the test process
 * manages itself, for isolation the already-running server can give for
 * free: instead of a new container per run, each run creates and drops its
 * own uniquely-named, empty database on the server that is already there.
 * Same isolation (a fresh database, guaranteed empty, gone afterwards), zero
 * new dependency, nothing to keep compatible with the pinned `pg`/`drizzle-orm`
 * versions.
 *
 * If the configured Postgres server is unreachable, every function below
 * throws instead of swallowing the error — a database test that silently
 * skips is worse than one that fails, because it is trusted (issue #22:
 * "integration tests must fail loudly, never silently skip").
 */

const THROWAWAY_DB_PREFIX = 'tezusta_it_';

/**
 * Points `url` at a different database name on the same server, preserving
 * host, port, credentials, and query string.
 */
function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface ThrowawayDatabase {
  /** Connection URL for the fresh, empty database. */
  readonly url: string;
  /** Drops the database. Safe to call once, at the end of the test. */
  drop(): Promise<void>;
}

/**
 * Creates a uniquely-named, empty database on the same Postgres server as
 * `baseUrl` and returns its connection URL plus a teardown function.
 *
 * Connects to Postgres's own always-present `postgres` maintenance database
 * to run `CREATE DATABASE`/`DROP DATABASE` — a connection cannot run either
 * statement against the database it is currently connected to, and unlike
 * `baseUrl`'s own database name (which differs between local dev and CI —
 * see `docker-compose.yml` vs `.github/workflows/ci.yml`), `postgres` is
 * guaranteed to exist on any standard Postgres server.
 */
export async function createThrowawayDatabase(baseUrl: string): Promise<ThrowawayDatabase> {
  const adminUrl = withDatabaseName(baseUrl, 'postgres');
  // A UUID we generate ourselves, so interpolating it into DDL below is safe
  // — Postgres has no parameterised form of CREATE/DROP DATABASE, whose
  // target is an identifier, not a value.
  const name = `${THROWAWAY_DB_PREFIX}${randomUUID().replace(/-/g, '')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  return {
    url: withDatabaseName(baseUrl, name),
    async drop(): Promise<void> {
      const dropAdmin = new Client({ connectionString: adminUrl });
      await dropAdmin.connect();
      try {
        // A pool the test forgot to close would otherwise leave DROP
        // DATABASE blocked behind an open session on `name`.
        await dropAdmin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        );
        await dropAdmin.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
