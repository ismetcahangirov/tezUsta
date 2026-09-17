import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { parseEnv } from '../../src/infra/config/parse-env';
import {
  createThrowawayDatabase,
  isSweepable,
  sweepStaleThrowawayDatabases,
  throwawayDatabaseName,
} from './throwaway-database';

/**
 * Issue #50. A test run that dies between `CREATE DATABASE` and its `afterAll`
 * — Ctrl-C, a crash, a killed watch run — used to leave a `tezusta_it_*`
 * database behind forever.
 *
 * The dangerous fix is the obvious one, so it is the one asserted against here:
 * Vitest runs test files in parallel, each with its own throwaway database, and
 * an unfiltered prefix sweep would drop a sibling suite's database mid-run.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * What the four tests below are allowed to spend, against Vitest's 5-second
 * default for an `it()`.
 *
 * Raised per test rather than globally, because `vitest.config.mts` deliberately
 * leaves `testTimeout` alone — "a slow assertion is still a failure" — and that
 * is still the right rule. These four are not slow assertions: each one is a
 * `CREATE DATABASE`, a sweep that enumerates and drops databases, and a
 * `DROP DATABASE` afterwards, all of which serialise on the Postgres server
 * against every other suite in the run doing the same thing. The number that
 * has to grow is therefore the server's, not this file's, and it grows every
 * time a Postgres-backed suite is added — two arrived with this change and put
 * these two over the default.
 */
const AGAINST_A_BUSY_SERVER = 30_000;

function baseUrl(): string {
  return parseEnv(process.env).database.url;
}

function adminUrl(): string {
  const url = new URL(baseUrl());
  url.pathname = '/postgres';
  return url.toString();
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return result.rowCount === 1;
  });
}

describe('which throwaway databases the sweep is willing to drop', () => {
  const now = Date.now();

  it('leaves a database created moments ago alone — a sibling suite owns it', () => {
    expect(isSweepable(throwawayDatabaseName(now), now)).toBe(false);
    expect(isSweepable(throwawayDatabaseName(now - 60_000), now)).toBe(false);
  });

  it('sweeps one older than the window, which no live run can still own', () => {
    expect(isSweepable(throwawayDatabaseName(now - FIFTEEN_MINUTES_MS), now)).toBe(true);
    expect(isSweepable(throwawayDatabaseName(now - 48 * 60 * 60 * 1000), now)).toBe(true);
  });

  it('never touches a name outside the tezusta_it_ prefix, however old it looks', () => {
    for (const name of [
      'postgres',
      'tezusta',
      'tezusta_test',
      'tezusta_it', // the prefix without its trailing underscore
      'not_tezusta_it_00000000000000000000000000000000',
      // `_` is a single-character wildcard in LIKE, so this one IS returned by
      // the candidate query. The JS check is what excludes it.
      'tezustaXitY0_00000000000000000000000000000000',
    ]) {
      expect(isSweepable(name, now)).toBe(false);
    }
  });

  it('sweeps the pre-issue-#50 name format, which carries no timestamp to age', () => {
    expect(isSweepable(`tezusta_it_${randomUUID().replace(/-/g, '')}`, now)).toBe(true);
  });

  it('keeps the generated name inside Postgres’s 63-byte identifier limit', () => {
    expect(throwawayDatabaseName(now).length).toBeLessThanOrEqual(63);
  });
});

describe('sweeping stale throwaway databases against a real server', () => {
  const created: string[] = [];

  afterEach(async () => {
    await withAdmin(async (client) => {
      for (const name of created.splice(0)) {
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      }
    });
  });

  async function createNamed(name: string): Promise<void> {
    created.push(name);
    await withAdmin((client) => client.query(`CREATE DATABASE "${name}"`));
  }

  it(
    'drops a database orphaned by a killed run',
    async () => {
      const orphan = throwawayDatabaseName(Date.now() - 2 * FIFTEEN_MINUTES_MS);
      await createNamed(orphan);

      await sweepStaleThrowawayDatabases(baseUrl());

      // The end state, not the return value. Every test FILE in this suite runs
      // in its own worker and sweeps on its first `createThrowawayDatabase`, so
      // a sibling worker starting up a moment before this line is entitled to
      // drop this orphan first — which is the behaviour being asserted, just
      // performed by somebody else. Asserting `dropped` would make this test
      // fail on scheduling, which is precisely the kind of flake issue #50 warns
      // the naive fix produces.
      expect(await databaseExists(orphan)).toBe(false);
    },
    AGAINST_A_BUSY_SERVER,
  );

  it(
    "leaves a running suite's database alone",
    async () => {
      // The real thing, through the real helper — this is what a sibling test
      // file holds while this one sweeps.
      const sibling = await createThrowawayDatabase(baseUrl());
      const siblingName = new URL(sibling.url).pathname.slice(1);

      try {
        const dropped = await sweepStaleThrowawayDatabases(baseUrl());

        expect(dropped).not.toContain(siblingName);
        expect(await databaseExists(siblingName)).toBe(true);
      } finally {
        await sibling.drop();
      }
    },
    AGAINST_A_BUSY_SERVER,
  );

  it(
    'leaves a database outside the prefix alone even when it is old',
    async () => {
      // Named to be caught by the LIKE pattern's `_` wildcards and rejected in
      // JS: if the prefix check were ever dropped, this test is what fails.
      const bystander = `tezustaXitY0_${randomUUID().replace(/-/g, '')}`;
      await createNamed(bystander);

      const dropped = await sweepStaleThrowawayDatabases(baseUrl());

      expect(dropped).not.toContain(bystander);
      expect(await databaseExists(bystander)).toBe(true);
    },
    AGAINST_A_BUSY_SERVER,
  );

  it(
    'does not drop an old database that still has a live session',
    async () => {
      // The second belt: a suite that somehow outlives the age window is still
      // protected by the connection it is holding.
      const busy = throwawayDatabaseName(Date.now() - 2 * FIFTEEN_MINUTES_MS);
      await createNamed(busy);

      const url = new URL(baseUrl());
      url.pathname = `/${busy}`;
      const holder = new Client({ connectionString: url.toString() });
      await holder.connect();

      try {
        const dropped = await sweepStaleThrowawayDatabases(baseUrl());

        expect(dropped).not.toContain(busy);
        expect(await databaseExists(busy)).toBe(true);
      } finally {
        await holder.end();
      }
    },
    AGAINST_A_BUSY_SERVER,
  );
});
