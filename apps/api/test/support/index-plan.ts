import type { Pool } from 'pg';

/**
 * `EXPLAIN (FORMAT JSON)` of `statement` with sequential scans switched off,
 * over freshly analysed statistics, as one JSON string (#465).
 *
 * This answers **"can an index serve this query"** — the claim an e2e suite
 * with a handful of rows can honestly make. "Would the planner choose it" needs
 * production-sized, analysed data, and `hot-path-plans.schema.test.ts` is
 * where that claim lives. Left on, the planner over a few rows picks a
 * sequential scan the moment the table has statistics, which autovacuum
 * writes whenever a long run gives it time: a test that passes alone and fails
 * in the full suite. Analysing here makes that state the same every run.
 *
 * Runs in its own transaction, rolled back, so the setting reaches nothing else.
 */
export async function indexPlanOf(
  pool: Pool,
  statement: string,
  params: readonly unknown[],
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('analyze orders');
    await client.query('set local enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': unknown[] }>(
      `explain (format json) ${statement}`,
      [...params],
    );
    return JSON.stringify(rows[0]?.['QUERY PLAN']);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
