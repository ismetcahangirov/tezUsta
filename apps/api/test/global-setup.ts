import {
  DEFER_DROP_ENV,
  dropThrowawayDatabasesCreatedSince,
  sweepStaleThrowawayDatabases,
} from './support/throwaway-database';

/**
 * Once per Vitest run, in the main process before any worker starts (#356).
 *
 * - **Before:** the stale sweep, once, instead of once per worker: databases
 *   orphaned by a run that never reached its teardown (#50).
 * - **During:** each suite's `drop()` is deferred (`DEFER_DROP_ENV`). Workers
 *   are forked after this runs, so they inherit the variable.
 * - **After:** every database this run created is dropped, when nothing is
 *   running any more, so the checkpoint each `DROP DATABASE` forces stalls no
 *   test.
 *
 * `DATABASE_URL` has the same fallback `setup-env.ts` gives the workers.
 */
export async function setup(): Promise<() => Promise<void>> {
  const baseUrl =
    process.env.DATABASE_URL ?? 'postgresql://tezusta:tezusta@localhost:15432/tezusta';
  const startedAt = Date.now();

  await sweepStaleThrowawayDatabases(baseUrl);
  process.env[DEFER_DROP_ENV] = '1';

  return async () => {
    const { failed } = await dropThrowawayDatabasesCreatedSince(baseUrl, startedAt);
    if (failed > 0) {
      // Not a failed run: the next run's stale sweep clears them.
      console.warn(`[test teardown] ${String(failed)} throwaway database(s) could not be dropped`);
    }
  };
}
