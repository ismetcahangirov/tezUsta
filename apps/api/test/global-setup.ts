import Redis from 'ioredis';
import type { TestProject } from 'vitest/node';

import {
  DEFER_DROP_ENV,
  dropRunThrowawayDatabases,
  newRunId,
  RUN_ID_ENV,
  sweepStaleThrowawayDatabases,
} from './support/throwaway-database';
import { deleteKeys } from './support/scan-keys';

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
 *   Then this run's Redis keys are deleted (#367): BullMQ's queues and
 *   socket.io's adapter stream have no TTL, and `setup-env.ts` puts the run's
 *   id in `QUEUE_PREFIX` and `REDIS_KEY_PREFIX` so they can be found. The rate
 *   limiter's keys expire by themselves. A run that never reaches this point is
 *   swept by a later run's setup, once it is an hour old.
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
  await sweepAbandonedRunKeys();
  if (project.vitest.config.watch) {
    return undefined;
  }

  const runId = newRunId();
  await registerRun(runId);
  process.env[RUN_ID_ENV] = runId;
  process.env[DEFER_DROP_ENV] = '1';

  return async () => {
    const { failed } = await dropRunThrowawayDatabases(baseUrl, runId);
    if (failed > 0) {
      // Not a failed run: a later run's stale sweep clears them.
      console.warn(`[test teardown] ${String(failed)} throwaway database(s) could not be dropped`);
    }
    await deleteRunKeys(runId);
  };
}

/**
 * Where a run records that it started, so that the keys of a run that never
 * reached its teardown (a Ctrl-C, a crash) can be found by a later one: they
 * have no TTL of their own. The registry is one hash, `run id -> start ms`.
 */
const RUN_REGISTRY_KEY = 'tezusta-test-runs';

/**
 * How old a run must be before a later run treats it as abandoned. A full
 * suite takes minutes; an hour is far past anything still running, the same
 * reasoning as the database sweep's fifteen minutes, with room for a slow
 * machine.
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

function connectRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
}

/** Runs `work` against Redis, best-effort: a failure is reported, never thrown. */
async function withRedis(what: string, work: (redis: Redis) => Promise<void>): Promise<void> {
  const redis = connectRedis();
  try {
    await redis.connect();
    await work(redis);
  } catch (error) {
    console.warn(
      `[test setup] ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    redis.disconnect();
  }
}

async function registerRun(runId: string): Promise<void> {
  await withRedis('registering the run', async (redis) => {
    await redis.hset(RUN_REGISTRY_KEY, runId, String(Date.now()));
  });
}

/**
 * Deletes every key under this run's prefixes: the queues (`test-<runId>-<pid>`,
 * and the `-producer-only` and `-other` variants deferred-work derives from it)
 * and the application's keys (`test-<runId>-<random>`), then the run's entry in
 * the registry.
 */
async function deleteRunKeys(runId: string): Promise<void> {
  await withRedis("deleting this run's keys", async (redis) => {
    await deleteKeys(redis, `test-${runId}-*`);
    await redis.hdel(RUN_REGISTRY_KEY, runId);
  });
}

/** The keys of every registered run older than `ABANDONED_AFTER_MS`, and their entries. */
async function sweepAbandonedRunKeys(): Promise<void> {
  await withRedis('sweeping abandoned runs', async (redis) => {
    const runs = await redis.hgetall(RUN_REGISTRY_KEY);
    for (const [runId, startedAt] of Object.entries(runs)) {
      if (Date.now() - Number(startedAt) < ABANDONED_AFTER_MS) {
        continue;
      }
      await deleteKeys(redis, `test-${runId}-*`);
      await redis.hdel(RUN_REGISTRY_KEY, runId);
    }
  });
}
