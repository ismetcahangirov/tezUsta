import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { geometry, index, pgTable, serial } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * This is the one risk EPIC 1 exists to de-risk (issue #22): proving that a
 * Drizzle-defined `geometry` column, exactly as ADR-0003 shapes it for
 * `master_locations.position`, round-trips through PostGIS end to end —
 * not merely that the extension is installed. Test-only: no business schema
 * lives in `src/infra/database/schema/`.
 */
const testPoints = pgTable(
  'test_points',
  {
    id: serial('id').primaryKey(),
    position: geometry('position', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
  },
  (t) => [
    // Indexing the plain geometry column (`index(...).using('gist', t.position)`,
    // ADR-0003's own snippet) does NOT accelerate the canonical
    // `ST_DWithin(position::geography, ...)` query from
    // docs/architecture/database-architecture.md § "The nearby-masters
    // query" — verified empirically below via `EXPLAIN` with
    // `enable_seqscan` forced off: a GiST index on the bare `geometry`
    // column supports geometry-typed operators only, and PostGIS registers
    // a SEPARATE opclass for `geography`. A `geography`-cast query can only
    // use a GiST index built on that same cast expression. This is the
    // exact "document vs artifact" gap CLAUDE.md §9 warns about, and is
    // flagged in this issue's report for whoever builds `master_locations`
    // in EPIC 6 — it is not this issue's place to edit an accepted ADR.
    index('test_points_position_geog_gist_idx').using('gist', sql`(${t.position}::geography)`),
  ],
);

// Column type Drizzle actually generates for `geometry('position', {type:'point',
// mode:'xy', srid:4326})` — verified against the installed
// drizzle-orm@0.45.2 source (`pg-core/columns/postgis_extension/geometry.js`,
// `PgGeometryObject.getSQLType()`): it returns exactly `geometry(point)`,
// with no SRID typmod, regardless of the `srid` config value. This DDL
// mirrors that exactly instead of guessing at a `geometry(Point, 4326)`
// typmod Drizzle does not actually emit.
const CREATE_TEST_TABLE = sql`
  CREATE TABLE test_points (
    id serial PRIMARY KEY,
    position geometry(point) NOT NULL
  )
`;

describe('a Drizzle-defined geometry column with a GiST index, end to end', () => {
  let pool: Pool;
  let db: NodePgDatabase<{ testPoints: typeof testPoints }>;
  let database: ThrowawayDatabase;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url); // CREATE EXTENSION IF NOT EXISTS postgis;

    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema: { testPoints } });

    await db.execute(CREATE_TEST_TABLE);
    await db.execute(
      sql`CREATE INDEX test_points_position_geog_gist_idx ON test_points USING gist ((position::geography))`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('inserts a point through the Drizzle schema and finds it with ST_DWithin', async () => {
    // Baku city centre and a point roughly 60km away — far outside the
    // search radius below.
    const bakuLng = 49.8671;
    const bakuLat = 40.4093;
    const farLng = 50.5;
    const farLat = 40.9;

    await db
      .insert(testPoints)
      .values([{ position: { x: bakuLng, y: bakuLat } }, { position: { x: farLng, y: farLat } }]);

    const near = { x: 49.87, y: 40.41 }; // a few hundred metres from Baku centre

    const withinRadius = await db
      .select({ id: testPoints.id, position: testPoints.position })
      .from(testPoints)
      .where(
        sql`ST_DWithin(${testPoints.position}::geography, ST_SetSRID(ST_MakePoint(${near.x}, ${near.y}), 4326)::geography, 5000)`,
      );

    expect(withinRadius).toHaveLength(1);
    expect(withinRadius[0]?.position).toEqual({ x: bakuLng, y: bakuLat });
  });

  it('uses the GiST index on the geography expression to answer ST_DWithin', async () => {
    const near = { x: 49.87, y: 40.41 };

    // `SET LOCAL` must share a connection with the `EXPLAIN` it is scoping,
    // and a bare `pool`/`db` call may borrow a different connection from the
    // pool per statement — `db.transaction` pins both to the same one, and
    // `LOCAL` auto-reverts at commit so nothing leaks to later tests.
    const planText = await db.transaction(async (tx) => {
      // Forces the planner away from a sequential scan so a two-row table
      // cannot "win" on cost alone — proving the index CAN answer the
      // query, not merely that the planner declined it on a table this
      // small.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);

      const plan = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN SELECT id FROM test_points WHERE ST_DWithin(position::geography, ST_SetSRID(ST_MakePoint(${near.x}, ${near.y}), 4326)::geography, 5000)`,
      );
      return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(planText).toContain('test_points_position_geog_gist_idx');
  });
});
