import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { redisRetryStrategy } from '../src/infra/redis/redis.module';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Both behaviours here were broken before review, and neither failure is
 * exotic: a Postgres restart and a Redis restart are routine operational
 * events — a failover, a maintenance window, a rolling upgrade, an idle
 * socket reaped by a load balancer.
 */
describe('infrastructure clients survive a dependency going away', () => {
  describe('the Postgres pool', () => {
    let database: ThrowawayDatabase;
    let pool: Pool;
    let killer: Pool;

    beforeAll(async () => {
      // A throwaway database, not the configured one: this test terminates
      // idle backends, and doing that on the shared database would reach into
      // whatever other suites have parked there. A test that breaks its
      // neighbours is a flaky test, which is a bug (CLAUDE.md §13).
      database = await createThrowawayDatabase(parseEnv(process.env).database.url);

      pool = new Pool({ connectionString: database.url, max: 2 });
      // The listener under test. `pg-pool` emits 'error' when a pooled-but-idle
      // connection breaks, and an EventEmitter with no 'error' listener throws
      // — which ends the process, not merely the query.
      pool.on('error', () => undefined);

      killer = new Pool({ connectionString: database.url, max: 1 });
      killer.on('error', () => undefined);
    });

    afterAll(async () => {
      await pool.end();
      await killer.end();
      await database.drop();
    });

    it('survives an idle connection being terminated, and serves the next query', async () => {
      // Warm the pool so a client is parked idle — exactly what the `postgres`
      // readiness check leaves behind after its `select 1`.
      await pool.query('select 1');

      const name = new URL(database.url).pathname.replace('/', '');
      await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND state = 'idle' AND pid <> pg_backend_pid()`,
        [name],
      );

      // Let the terminated socket surface as a pool 'error' event. Reaching
      // the assertion at all is most of the point: an unhandled 'error' would
      // have taken this process down before we got here.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { rows } = await pool.query<{ ok: number }>('select 1 as ok');
      expect(rows[0]?.ok).toBe(1);
    });
  });

  describe('the Redis reconnect strategy', () => {
    /**
     * Asserted as a property rather than by restarting the shared Redis
     * container, which would make every other suite flaky. The defect this
     * guards against was a strategy that returned `null` after three attempts:
     * `null` tells ioredis to give up permanently — status `end`, from which
     * it never returns to `wait`, so it never reconnects. With a 200/400/600ms
     * backoff that made about 1.2 seconds of unreachability fatal, and Redis
     * coming back healthy did not bring the client back with it.
     */
    it('returns a real delay for every attempt, so the client never gives up', () => {
      for (const attempt of [1, 2, 3, 4, 5, 10, 100, 10_000]) {
        const delay = redisRetryStrategy(attempt);
        expect(typeof delay).toBe('number');
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThan(0);
      }
    });

    it('caps the backoff so a long outage does not stretch to an unusable delay', () => {
      expect(redisRetryStrategy(1)).toBeLessThan(redisRetryStrategy(5));
      expect(redisRetryStrategy(10_000)).toBe(2000);
    });
  });
});
