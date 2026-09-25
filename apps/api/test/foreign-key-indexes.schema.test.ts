import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Issue #288 — every foreign key gets a supporting index.
 *
 * `performance.md` has always listed "missing FK index" as an anti-pattern —
 * Postgres does **not** create one automatically the way it does for a
 * primary key — but nothing enforced it. Without an index whose leading
 * columns cover the foreign key, a `DELETE` or a key `UPDATE` on the
 * referenced row makes Postgres sequentially scan the child table to check
 * nothing points at the row being changed, while holding a lock on the parent
 * the whole time; and any application lookup by that column is the same
 * sequential scan without the lock.
 *
 * The guard below reads `pg_constraint` and `pg_index` directly, after every
 * migration has run, rather than trusting a hand-maintained list: an
 * allow-list is exactly where the next missing index would hide.
 *
 * **What counts as "covering":** a non-expression index whose first N
 * columns, as a *set*, equal the foreign key's N columns — order does not
 * matter, because Postgres can use any leading prefix permutation to satisfy
 * the referential check equally well, and requiring one particular order
 * would reject a composite index that was ordered for a different, unrelated
 * read.
 *
 * **A partial index (`indpred is not null`) still counts, deliberately.**
 * Every existing single-column FK index in this schema that Postgres would
 * otherwise flag (`master_documents_reviewed_by_admin_idx`,
 * `order_photos_order_idx`, `reviews_removed_by_admin_idx`, and half a dozen
 * more) is partial on `column IS NOT NULL`, because the column is nullable
 * and most rows carry no value — indexing every one of those nulls would be
 * pure waste for a lookup or a referential check that can never match one.
 * Rejecting every partial index outright would make this guard fail on all of
 * them, demanding either a full index nobody's read pattern needs or a
 * predicate this file would have to duplicate and keep in step with each
 * table's own shape. What actually matters is only the **leading columns**:
 * an index that leads with the FK's columns is the one Postgres reaches for
 * whenever the FK's own value could plausibly appear.
 *
 * **An expression index (`indexprs is not null`) does not count.** Its
 * leading entries are computed values, not the FK's own columns, so a `0` in
 * `indkey` for that position never names the column the constraint refers to.
 *
 * No allow-list for either reason: this is a general rule over every foreign
 * key in `public`, not a list of exceptions to keep current by hand.
 */
describe('every foreign key has a covering index (issue #288)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('has no foreign key without a covering, non-expression index over its columns', async () => {
    const { rows } = await pool.query<{ table_name: string; constraint_name: string }>(
      `SELECT con.conrelid::regclass::text AS table_name,
              con.conname AS constraint_name
         FROM pg_constraint con
         JOIN pg_namespace ns ON ns.oid = con.connamespace
        WHERE con.contype = 'f'
          AND ns.nspname = 'public'
          AND NOT EXISTS (
                SELECT 1
                  FROM pg_index idx
                 WHERE idx.indrelid = con.conrelid
                   AND idx.indexprs IS NULL
                   AND (
                         SELECT array_agg(col ORDER BY col)
                           FROM unnest(idx.indkey[0:cardinality(con.conkey) - 1]) AS col
                       ) = (
                         SELECT array_agg(col ORDER BY col)
                           FROM unnest(con.conkey) AS col
                       )
              )
        ORDER BY table_name, constraint_name`,
    );

    // Written as the offending table/constraint pairs rather than a count, so
    // a failure names exactly what to fix instead of only saying that
    // something is wrong.
    expect(rows.map((row) => `${row.table_name}.${row.constraint_name}`)).toEqual([]);
  });
});
