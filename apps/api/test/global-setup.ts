import type { TestProject } from 'vitest/node';

import {
  DEFER_DROP_ENV,
  dropRunThrowawayDatabases,
  newRunId,
  RUN_ID_ENV,
  sweepStaleThrowawayDatabases,
} from './support/throwaway-database';

/**
 * Once per Vitest run, in the main process before any worker starts (#356).
 *
 * - **Before:** the stale sweep, once, instead of once per worker: databases
 *   orphaned by a run that never reached its teardown (#50). And this run's id
 *   (`RUN_ID_ENV`), which every database it creates carries in its name.
 * - **During:** each suite's `drop()` is deferred (`DEFER_DROP_ENV`). Workers
 *   are forked after this runs, so they inherit both variables.
 * - **After:** this run's databases, and only this run's, are dropped when
 *   nothing is running any more, so the checkpoint each `DROP DATABASE` forces
 *   stalls no test. `teardownTimeout` in `vitest.config.mts` gives it the time.
 *
 * **Not in watch mode.** There the teardown runs only when the session quits,
 * and every rerun would keep another 22 MB database until then; suites drop
 * their own databases as they finish, as they did before #356.
 *
 * `DATABASE_URL` has the same fallback `setup-env.ts` gives the workers.
 */
export async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const baseUrl =
    process.env.DATABASE_URL ?? 'postgresql://tezusta:tezusta@localhost:15432/tezusta';

  await sweepStaleThrowawayDatabases(baseUrl);
  if (project.vitest.config.watch) {
    return undefined;
  }

  const runId = newRunId();
  process.env[RUN_ID_ENV] = runId;
  process.env[DEFER_DROP_ENV] = '1';

  return async () => {
    const { failed } = await dropRunThrowawayDatabases(baseUrl, runId);
    if (failed > 0) {
      // Not a failed run: a later run's stale sweep clears them.
      console.warn(`[test teardown] ${String(failed)} throwaway database(s) could not be dropped`);
    }
  };
}
