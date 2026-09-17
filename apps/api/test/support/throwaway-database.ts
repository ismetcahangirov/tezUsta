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
 *
 * `sweepStaleThrowawayDatabases` is the one exception, and deliberately so: it
 * cleans up after runs that died before their teardown (issue #50), which is
 * hygiene rather than a guarantee anything asserts on. It never throws.
 */

const THROWAWAY_DB_PREFIX = 'tezusta_it_';

/**
 * How old a `tezusta_it_*` database must be before the sweep below will drop
 * it (issue #50).
 *
 * **A prefix sweep with no age filter is a bug, not a fix.** Vitest runs test
 * files in parallel and each one creates its own throwaway database, so
 * dropping everything that matches the prefix at the start of a run destroys a
 * sibling suite's database mid-test and produces failures that look random.
 *
 * Fifteen minutes is an order of magnitude past anything legitimate: a suite's
 * database lives from its `beforeAll` to its `afterAll`, and `vitest.config.mts`
 * caps a hook at 60 seconds. Nothing this sweep can see at fifteen minutes old
 * belongs to a run that is still going.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * `tezusta_it_<base36 ms>_<32 hex>` — 52 characters, inside Postgres's 63-byte
 * identifier limit.
 *
 * The timestamp is in the NAME because Postgres does not expose a creation
 * time for a database: `pg_database` has no such column, and the filesystem
 * mtime of its directory is not reachable over SQL. Encoding it is what makes
 * an age filter possible at all.
 */
export function throwawayDatabaseName(nowMs: number = Date.now()): string {
  return `${THROWAWAY_DB_PREFIX}${nowMs.toString(36)}_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The shape `throwawayDatabaseName` produces, after the prefix: a base36
 * millisecond stamp, then the hex of a UUID.
 */
const TIMESTAMPED_SUFFIX = /^([0-9a-z]{1,10})_([0-9a-f]{32})$/;

/**
 * Whether `name` is a throwaway database the sweep may drop, at `nowMs`.
 *
 * Pure, and exported, so the rule that decides what gets dropped is testable
 * without a Postgres server — see `throwaway-database.test.ts`.
 *
 * A name outside the prefix is never sweepable, whatever it looks like. A name
 * inside the prefix that does not carry a timestamp is from the format this
 * helper used before issue #50 (`tezusta_it_<32 hex>`), so nothing running
 * today can own it; it is sweepable on sight, and the caller's "no live
 * session" check is what still protects an older checkout running alongside.
 */
export function isSweepable(name: string, nowMs: number): boolean {
  if (!name.startsWith(THROWAWAY_DB_PREFIX)) {
    return false;
  }

  const match = TIMESTAMPED_SUFFIX.exec(name.slice(THROWAWAY_DB_PREFIX.length));
  if (match === null) {
    return true;
  }

  const createdAt = Number.parseInt(match[1] ?? '', 36);
  return nowMs - createdAt >= STALE_AFTER_MS;
}

interface DatabaseRow {
  datname: string;
  sessions: string;
}

/**
 * Drops `tezusta_it_*` databases left behind by a run that never reached its
 * teardown — a Ctrl-C, a crash, a killed watch run (issue #50).
 *
 * Best-effort by design: **a failure here never fails a test run.** This is
 * hygiene, not a gate, and a developer whose Postgres role cannot drop a
 * database should still be able to run the suite.
 *
 * Two independent conditions have to hold before anything is dropped — the age
 * filter above, and no live session on the database. The age filter is what
 * makes it safe; the session check is the second belt, for the case where a
 * single suite somehow outlives the window.
 */
export async function sweepStaleThrowawayDatabases(
  baseUrl: string,
  nowMs = Date.now(),
): Promise<string[]> {
  const admin = new Client({ connectionString: withDatabaseName(baseUrl, 'postgres') });
  const dropped: string[] = [];

  try {
    await admin.connect();
  } catch {
    return dropped;
  }

  try {
    const candidates = await admin.query<DatabaseRow>(
      `SELECT d.datname,
              (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessions
         FROM pg_database d
        WHERE d.datname LIKE $1`,
      [`${THROWAWAY_DB_PREFIX}%`],
    );

    for (const row of candidates.rows) {
      // The prefix is re-checked in JS rather than trusted to LIKE, whose `_`
      // is a single-character wildcard: `tezusta_it_%` as a pattern also
      // matches `tezustaXitY...`. Nothing outside the prefix is ever dropped.
      if (!isSweepable(row.datname, nowMs) || row.sessions !== '0') {
        continue;
      }

      try {
        await admin.query(`DROP DATABASE IF EXISTS "${row.datname}"`);
        dropped.push(row.datname);
      } catch {
        // Another worker swept it first, or it acquired a session between the
        // query and the drop. Either way it is not this run's problem.
      }
    }
  } catch {
    // No permission to read pg_database, a server that went away — nothing
    // here is worth failing a test over.
  } finally {
    await admin.end().catch(() => undefined);
  }

  return dropped;
}

/**
 * The sweep runs once per process, not once per suite: every test file in a
 * worker shares this module, and fourteen scans of `pg_database` would buy
 * nothing over one. Awaited by `createThrowawayDatabase` so a suite cannot
 * create its database while the sweep is still deciding what to drop.
 */
let sweepOnce: Promise<unknown> | undefined;

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
  sweepOnce ??= sweepStaleThrowawayDatabases(baseUrl);
  await sweepOnce;

  const adminUrl = withDatabaseName(baseUrl, 'postgres');
  // A timestamp and a UUID we generate ourselves, so interpolating them into
  // DDL below is safe — Postgres has no parameterised form of CREATE/DROP
  // DATABASE, whose target is an identifier, not a value.
  const name = throwawayDatabaseName();

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
        try {
          await dropAdmin.query(`DROP DATABASE IF EXISTS "${name}"`);
          return;
        } catch (error) {
          // 55006 object_in_use: something still holds a session on `name`.
          // Anything else is a real failure and is not ours to reinterpret.
          if ((error as { code?: string }).code !== '55006') {
            throw error;
          }
        }

        // **Terminating is the fallback, not the first move**, and the order
        // matters more than it looks.
        //
        // Terminating unconditionally used to be the first statement here, and
        // it made a correctly-written suite fail at random: killing a backend
        // makes `pg` emit an `error` on whatever client owned it, and a raw
        // `new Pool()` in a test usually has no `error` listener, so Node
        // surfaces it as an unhandled rejection and Vitest fails the whole run
        // — with a message about `57P01 terminating connection` that names no
        // test and points at no assertion. It showed up under CI load, where a
        // socket is still closing a moment after `pool.end()` resolves.
        //
        // Trying the DROP first means the normal path — every suite closed
        // what it opened — terminates nothing at all. A termination now
        // happens only when a session really is still there, which is a leak
        // worth the noise it makes.
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
