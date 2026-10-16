import { randomBytes, randomUUID } from 'node:crypto';

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
 * Fifteen minutes is past anything legitimate for a database still in use: a
 * suite holds a session on its database from its `beforeAll` to its `afterAll`,
 * and `vitest.config.mts` caps a hook at 60 seconds. Since #356 a finished
 * suite's database stays until its run's teardown, so a long run can leave one
 * older than this with no session on it; another run's sweep may then drop it,
 * which costs that finished suite nothing.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * `tezusta_it_<base36 ms>_<32 hex>` — 52 characters, inside Postgres's 63-byte
 * identifier limit.
 *
 * Inside a Vitest run the hex starts with the run's id (`RUN_ID_ENV`, eight hex
 * characters), so the run's teardown drops exactly its own databases and never
 * those of another run on the same server (#356).
 *
 * The timestamp is in the NAME because Postgres does not expose a creation
 * time for a database: `pg_database` has no such column, and the filesystem
 * mtime of its directory is not reachable over SQL. Encoding it is what makes
 * an age filter possible at all.
 */
export function throwawayDatabaseName(
  nowMs: number = Date.now(),
  runId: string | undefined = process.env[RUN_ID_ENV],
): string {
  const random = randomUUID().replace(/-/g, '');
  const hex = runId === undefined ? random : `${runId}${random.slice(runId.length)}`;
  return `${THROWAWAY_DB_PREFIX}${nowMs.toString(36)}_${hex}`;
}

/** Set by `test/global-setup.ts`: eight hex characters naming this Vitest run (#356). */
export const RUN_ID_ENV = 'TEZUSTA_IT_RUN_ID';

/** A fresh run id, for `RUN_ID_ENV`. */
export function newRunId(): string {
  return randomBytes(4).toString('hex');
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

export interface SweepOptions {
  /**
   * Which names this call is willing to consider stale. Defaults to the age
   * rule above, read from the clock once, when the sweep starts.
   *
   * **This is a test seam, and it exists because the alternative is a race**
   * (issue #161). Proving that a live session spares a database needs a
   * database that is both old and connected — and a database that *looks* old
   * is, for the moments between `CREATE DATABASE` and the test's own
   * connection, exactly what every sibling worker's sweep exists to drop. The
   * test used to lose that race and fail with `database ... does not exist`.
   *
   * Naming the database honestly (a current timestamp, like every real suite)
   * removes the hazard, and this predicate is how the test then says "treat
   * *this one* as stale" — without widening the age window, which would point
   * the same sweep at every sibling's fresh database instead.
   */
  readonly isStale?: (name: string) => boolean;
}

/**
 * The sweep's entire decision about one candidate, in one place.
 *
 * **It is here, and exported, because a real server cannot tell the two halves
 * apart.** Postgres itself refuses (`55006 object_in_use`) to drop a database
 * that has a live session, and the sweep swallows that refusal — so a sweep
 * which had lost its session check would leave *exactly* the end state a
 * correct one leaves: the database still there, and not in `dropped`. An
 * integration test asserting that end state passes either way, which is worth
 * knowing: it is the reason issue #161's "a sweep that ignored live sessions
 * must still fail this test" is answered here rather than against Postgres.
 *
 * The prefix is re-checked rather than trusted to the caller's `isStale`, and
 * rather than to the LIKE pattern that produced the row — `_` is a
 * single-character wildcard, so `tezusta_it_%` also matches `tezustaXitY...`.
 * Nothing outside the prefix is ever dropped, whatever a caller says.
 */
export function isDroppable(
  name: string,
  liveSessions: number,
  isStale: (name: string) => boolean,
): boolean {
  return name.startsWith(THROWAWAY_DB_PREFIX) && isStale(name) && liveSessions === 0;
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
  options: SweepOptions = {},
): Promise<string[]> {
  const nowMs = Date.now();
  const isStale = options.isStale ?? ((name: string): boolean => isSweepable(name, nowMs));
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
      if (!isDroppable(row.datname, Number(row.sessions), isStale)) {
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
 * Outside a deferred run (watch mode, or a script calling this helper on its
 * own), the sweep runs once per process, not once per suite: every test file in
 * a worker shares this module, and fourteen scans of `pg_database` would buy
 * nothing over one. Awaited by `createThrowawayDatabase` so a suite cannot
 * create its database while the sweep is still deciding what to drop. In a
 * deferred run the global setup sweeps instead, once.
 */
let sweepOnce: Promise<unknown> | undefined;

/**
 * Set by `test/global-setup.ts` for a whole Vitest run (#356): each suite's
 * `drop()` leaves its database in place, and the run's teardown drops them all
 * once every test has finished.
 *
 * **Why.** `DROP DATABASE` makes Postgres take a checkpoint and wait for it:
 * every dirty buffer written, the WAL synced. A suite finishing while others
 * run therefore stalled their writes on `WALWrite`/`WalSync` for seconds, and
 * a test that takes 40 ms alone took 3 s, in whichever file happened to be
 * writing at that moment. Sampling `pg_stat_activity` during a full run showed
 * exactly that: an `update "sessions"` waiting on `WALWrite` while three drops
 * waited on the checkpoint. A migrated database is about 22 MB, so a run holds
 * a couple of gigabytes until its end.
 *
 * The startup sweep moves to the global setup too: once per run instead of
 * once per worker. Not in watch mode, where the setup's teardown only runs on
 * quit: there each suite drops its own database as before.
 */
export const DEFER_DROP_ENV = 'TEZUSTA_IT_DEFER_DROP';

function dropIsDeferred(): boolean {
  return process.env[DEFER_DROP_ENV] === '1';
}

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
  if (!dropIsDeferred()) {
    sweepOnce ??= sweepStaleThrowawayDatabases(baseUrl);
    await sweepOnce;
  }

  const adminUrl = withDatabaseName(baseUrl, 'postgres');
  // A timestamp and a UUID we generate ourselves, so interpolating them into
  // DDL below is safe — Postgres has no parameterised form of CREATE/DROP
  // DATABASE, whose target is an identifier, not a value.
  const name = throwawayDatabaseName();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    // A commit here does not wait for its WAL to reach the disk (#356). Every
    // commit used to: sampling a full run showed `WalSync` on `commit` as the
    // commonest wait, and on Docker Desktop's virtual disk an fsync now and
    // then stalls for seconds, which froze every writing test in every file at
    // once. Visibility is unchanged: a committed row is seen by every other
    // session at once; what an OS crash could lose is the last few
    // milliseconds of a database that is thrown away anyway. Unlike
    // `fsync = off` it cannot corrupt anything, and it touches no database but
    // this one.
    await admin.query(`ALTER DATABASE "${name}" SET synchronous_commit = off`);
  } finally {
    await admin.end();
  }

  return {
    url: withDatabaseName(baseUrl, name),
    async drop(): Promise<void> {
      if (dropIsDeferred()) {
        // The run's teardown drops it, after every test (see DEFER_DROP_ENV).
        return;
      }
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

/**
 * Drops every throwaway database of the run `runId` names (`RUN_ID_ENV`), and
 * no other: another run on the same server, or a watch session beside this
 * one, keeps its databases. `WITH (FORCE)` ends any session still open, which
 * by the end of a run is only a pool that was never closed.
 *
 * A few at a time, over `parallel` connections: each drop waits on the
 * checkpoint it forces, about 150 ms on an idle server, and a run makes about
 * a hundred. Best-effort like the sweep: a failure is counted, never thrown,
 * and what is left is a later run's stale sweep to clear.
 */
export async function dropRunThrowawayDatabases(
  baseUrl: string,
  runId: string,
  parallel = 4,
): Promise<{ dropped: number; failed: number }> {
  const adminUrl = withDatabaseName(baseUrl, 'postgres');
  const lister = new Client({ connectionString: adminUrl });
  let names: string[];
  try {
    await lister.connect();
    const { rows } = await lister.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${THROWAWAY_DB_PREFIX}%`],
    );
    names = rows
      .map((row) => row.datname)
      .filter((name) => {
        const match = TIMESTAMPED_SUFFIX.exec(name.slice(THROWAWAY_DB_PREFIX.length));
        return match !== null && (match[2] ?? '').startsWith(runId);
      });
  } catch {
    return { dropped: 0, failed: 0 };
  } finally {
    await lister.end().catch(() => undefined);
  }

  let dropped = 0;
  let failed = 0;
  const queue = [...names];
  const worker = async (): Promise<void> => {
    const admin = new Client({ connectionString: adminUrl });
    try {
      await admin.connect();
    } catch {
      failed += queue.splice(0).length;
      return;
    }
    try {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          dropped += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      await admin.end().catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, names.length) }, worker));
  return { dropped, failed };
}
