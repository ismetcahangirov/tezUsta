import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Location ingest — `POST /masters/me/location` — under realistic concurrent
 * master load (issue #290).
 *
 * ```bash
 * docker compose up -d
 * MASTER_LOCATION_BENCHMARK=1 pnpm --filter api exec vitest run test/master-location.benchmark.test.ts
 * ```
 *
 * Overridable: `MASTER_LOCATION_BENCHMARK_MASTERS` (default {@link DEFAULT_MASTER_COUNT}),
 * `MASTER_LOCATION_BENCHMARK_DURATION_SECONDS` (default {@link DEFAULT_DURATION_SECONDS}),
 * `MASTER_LOCATION_BENCHMARK_WARMUP_SECONDS` (default {@link DEFAULT_WARMUP_SECONDS}),
 * `MASTER_LOCATION_P95_BUDGET_MS` (default {@link DEFAULT_P95_BUDGET_MS}).
 *
 * **Opt-in, for the reason `nearby-masters.benchmark.test.ts` gives**: this is
 * a latency-and-throughput *measurement*, not a correctness claim, and
 * correctness of ingest is already asserted unconditionally, with no
 * database-dependent skip, in `master-location.e2e.test.ts`
 * (CLAUDE.md §13). Seeding thousands of masters and driving load for a real
 * duration is minutes of work nobody should pay on every `pnpm test`.
 *
 * ## What is being measured
 *
 * The **whole write path** behind one report: the bearer token round trip
 * through `AuthenticationGuard`/`RolesGuard`, the `location-report`
 * rate-limit check, the plausibility comparison against the master's previous
 * fix (issue #274, [ADR-0044](../../docs/decisions/ADR-0044-location-plausibility.md)),
 * the `INSERT` into `master_locations` inside its retention-pruning
 * transaction, the presence refresh in Redis, and — for the masters on an
 * active order — the fan-out lookup of `orders.master_id` and the Redis
 * throttle window `MasterPositionPublisher` gates a broadcast behind
 * (`docs/architecture/realtime-architecture.md` § The server → customer
 * throttle). `MasterLocationService.report` awaits every one of those before
 * answering, so all of it is inside the number below.
 *
 * This is real HTTP: the real `AppModule` graph is booted on a real Fastify
 * port with `app.listen(0)`, and every request is `fetch` against that port
 * with a real, minted access token — not a call straight into the service,
 * which is what `nearby-masters.benchmark.test.ts` measures instead and says
 * why (no auth guard, no rate limiter, no HTTP framing on that path).
 *
 * ## The dataset and the load shape
 *
 * {@link DEFAULT_MASTER_COUNT} masters are seeded set-based — bulk `INSERT …
 * SELECT … FROM unnest(...)`, not one row per HTTP call — as `active`,
 * `is_available`, with a `master` role grant, which is everything
 * `MasterLocationService.report`'s eligibility check
 * (`MastersService.assertCanAcceptWork`) asks for. {@link ON_ORDER_FRACTION}
 * of them additionally get an `ACCEPTED` order, seeded the same set-based way
 * `dispatch-metrics.integration.test.ts` seeds one — bypassing dispatch
 * entirely, because what this file measures is the fan-out **lookup**, not
 * dispatch — so their reports also pay the fan-out lookup and throttle check.
 *
 * Each seeded master gets a real access token, minted the way
 * `master-location.e2e.test.ts` mints one: `SessionsService.startSession`
 * in-process, never over HTTP, bounded to {@link TOKEN_MINT_CONCURRENCY} at a
 * time so seeding thousands of sessions does not open thousands of pool
 * connections at once.
 *
 * Once minted, every master runs its **own independent loop** rather than
 * being driven by one shared throughput generator: it sleeps for a jittered
 * interval at the reporting floor its state implies
 * (`docs/architecture/realtime-architecture.md` § Location update budget —
 * [ADR-0026](../../docs/decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)),
 * moves a small, always-plausible step, and reports. A master on an active
 * order floors at 10–15 s with up to a 25 m step; every other online master
 * floors at 60–120 s with up to a 100 m step. Every step stays far under
 * `MASTER_LOCATION_JUMP_FLOOR_M` (1 000 m by default), so the plausibility
 * check always accepts it regardless of elapsed time — this file simulates
 * the mandatory floor report, not the optional extra reports the client's own
 * distance filter would add between floors, which cost the same write and
 * would only inflate the request count without changing what is measured.
 *
 * In-flight requests are additionally capped by {@link MAX_CONCURRENT_REQUESTS}
 * — a plain counting semaphore, no new dependency — so a slow server cannot
 * make the generator itself pile up an unbounded number of open sockets.
 *
 * ## What is reported, and what it does not claim
 *
 * p50/p95/p99/max, achieved requests per second, a count of responses by HTTP
 * status, the API's own database pool's peak `waitingCount` (read straight off
 * `db.$client`, which `Database`'s own type — `NodePgDatabase & { $client:
 * Pool }` — guarantees is reachable in this codebase), and the **generator's**
 * event-loop delay via `perf_hooks.monitorEventLoopDelay`. That last one
 * matters because the generator runs in the same process as the code under
 * test: a generator whose own loop is saturated would show up as server
 * latency in the samples above if nobody were watching it separately.
 *
 * `MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR` and `..._PER_IP_HOUR` are raised
 * to the schema's own ceiling (`env.schema.ts`, `boundedInt(_, 1, 10_000)`)
 * for this run only, restored in `afterAll` — see the comment beside the
 * `set(...)` calls in `beforeAll` for why, and why the per-IP ceiling is a
 * real limitation of driving thousands of simulated masters from one
 * process's one loopback address rather than of the endpoint. `429
 * RATE_LIMITED` is therefore an **expected** status at high master counts and
 * does not fail the run; any other non-200 does.
 *
 * This is one process's view of one database on whatever hardware ran it —
 * hardware and Postgres/Redis versions are printed with the numbers for that
 * reason. It is not a claim about production capacity, only about this
 * write path's latency under this much concurrency on this machine.
 */

const DEFAULT_MASTER_COUNT = 2_000;
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_WARMUP_SECONDS = 20;
const DEFAULT_P95_BUDGET_MS = 200;

const MASTER_COUNT = Number(process.env.MASTER_LOCATION_BENCHMARK_MASTERS ?? DEFAULT_MASTER_COUNT);
const DURATION_SECONDS = Number(
  process.env.MASTER_LOCATION_BENCHMARK_DURATION_SECONDS ?? DEFAULT_DURATION_SECONDS,
);
const WARMUP_SECONDS = Number(
  process.env.MASTER_LOCATION_BENCHMARK_WARMUP_SECONDS ?? DEFAULT_WARMUP_SECONDS,
);
const P95_BUDGET_MS = Number(process.env.MASTER_LOCATION_P95_BUDGET_MS ?? DEFAULT_P95_BUDGET_MS);

/** The fraction of masters seeded with an active order, so their reports also pay the fan-out lookup. */
const ON_ORDER_FRACTION = 0.1;

/** `docs/architecture/realtime-architecture.md` § Location update budget. */
const ON_ORDER_FLOOR_SECONDS: readonly [number, number] = [10, 15];
const ON_ORDER_DISTANCE_FILTER_M = 25;
const IDLE_FLOOR_SECONDS: readonly [number, number] = [60, 120];
const IDLE_DISTANCE_FILTER_M = 100;

const TOKEN_MINT_CONCURRENCY = 100;
const MAX_CONCURRENT_REQUESTS = Math.min(MASTER_COUNT, 500);

const CITY_CENTRE = { latitude: 40.372613, longitude: 49.842717 };
/** Metres — the radius seeded masters start scattered within, uniform by area. */
const START_SPREAD_M = 12_000;
const EARTH_RADIUS_M = 6_378_137;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

/** A short hop in a random direction, small enough to always clear the jump floor. */
function moveBy(
  latitude: number,
  longitude: number,
  distanceM: number,
  bearingRad: number,
): { latitude: number; longitude: number } {
  const dLat = (distanceM * Math.cos(bearingRad)) / EARTH_RADIUS_M;
  const dLng =
    (distanceM * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos((latitude * Math.PI) / 180));
  return {
    latitude: latitude + (dLat * 180) / Math.PI,
    longitude: longitude + (dLng * 180) / Math.PI,
  };
}

/** A plain counting semaphore — bounded concurrency with no new dependency. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next !== undefined) {
        next();
      }
    };
  }
}

interface MasterDriver {
  readonly masterId: string;
  readonly accessToken: string;
  readonly onOrder: boolean;
  readonly floorRangeSeconds: readonly [number, number];
  readonly distanceFilterM: number;
  latitude: number;
  longitude: number;
}

interface SeededMasters {
  readonly userIds: readonly string[];
  readonly masterIds: readonly string[];
}

describe.runIf(process.env.MASTER_LOCATION_BENCHMARK === '1')(
  'master location ingest — concurrent load (issue #290)',
  () => {
    let app: NestFastifyApplication;
    let database: ThrowawayDatabase;
    let pool: Pool;
    let redis: Redis;
    let db: Database;
    let baseUrl: string;
    let serviceId: string;
    const saved = new Map<string, string | undefined>();

    function set(name: string, value: string): void {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }

    /** Bulk-inserts `count` eligible masters — `active`, `is_available`, `master` role — as one shape. */
    async function seedMasters(count: number): Promise<SeededMasters> {
      const userIds = Array.from({ length: count }, () => randomUUID());
      const masterIds = Array.from({ length: count }, () => randomUUID());
      const phones = userIds.map((_, i) => `+99470${String(i + 1).padStart(7, '0')}`);

      await pool.query(
        `insert into users (id, phone_e164) select * from unnest($1::uuid[], $2::text[])`,
        [userIds, phones],
      );
      await pool.query(
        `insert into masters (id, user_id, display_name, verification_status, is_available)
         select m, u, 'Bench Master', 'active', true
           from unnest($1::uuid[], $2::uuid[]) as t(m, u)`,
        [masterIds, userIds],
      );
      await pool.query(
        `insert into user_roles (user_id, role)
         select u, 'master' from unnest($1::uuid[]) as t(u)`,
        [userIds],
      );

      return { userIds, masterIds };
    }

    /**
     * Bulk-inserts one customer, one address and one `ACCEPTED` order per
     * given master — directly, the way `dispatch-metrics.integration.test.ts`
     * seeds an order, bypassing dispatch entirely. What this file measures is
     * the fan-out **lookup** a report performs, not dispatch.
     */
    async function seedActiveOrders(masterIds: readonly string[]): Promise<void> {
      if (masterIds.length === 0) {
        return;
      }
      const custUserIds = masterIds.map(() => randomUUID());
      const customerIds = masterIds.map(() => randomUUID());
      const addressIds = masterIds.map(() => randomUUID());
      const orderIds = masterIds.map(() => randomUUID());
      const idempotencyKeys = masterIds.map(() => randomUUID());
      const phones = custUserIds.map((_, i) => `+99471${String(i + 1).padStart(7, '0')}`);

      await pool.query(
        `insert into users (id, phone_e164) select * from unnest($1::uuid[], $2::text[])`,
        [custUserIds, phones],
      );
      await pool.query(
        `insert into customers (id, user_id, display_name)
         select c, u, 'Bench Customer' from unnest($1::uuid[], $2::uuid[]) as t(c, u)`,
        [customerIds, custUserIds],
      );
      await pool.query(
        `insert into addresses (id, customer_id, formatted_address, position)
         select a, c, 'Bench address',
                ST_SetSRID(ST_MakePoint($3 + (random() - 0.5) * 0.01, $4 + (random() - 0.5) * 0.01), 4326)
           from unnest($1::uuid[], $2::uuid[]) as t(a, c)`,
        [addressIds, customerIds, CITY_CENTRE.longitude, CITY_CENTRE.latitude],
      );
      await pool.query(
        `insert into orders (id, customer_id, address_id, service_id, master_id, status,
                             description, idempotency_key, accepted_at, created_at, updated_at)
         select o, c, a, $6::uuid, m, 'ACCEPTED', 'Benchmark active order', k, now(), now(), now()
           from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[]) as t(o, c, a, m, k)`,
        [orderIds, customerIds, addressIds, masterIds, idempotencyKeys, serviceId],
      );
    }

    /** Mints one real access token per master, in-process, the way `master-location.e2e.test.ts` does. */
    async function mintTokens(
      userIds: readonly string[],
      sessions: SessionsService,
    ): Promise<readonly string[]> {
      const semaphore = new Semaphore(TOKEN_MINT_CONCURRENCY);
      return Promise.all(
        userIds.map(async (userId) => {
          const release = await semaphore.acquire();
          try {
            const pair = await sessions.startSession({ userId });
            return pair.accessToken;
          } finally {
            release();
          }
        }),
      );
    }

    function buildDrivers(
      masterIds: readonly string[],
      accessTokens: readonly string[],
      onOrderCount: number,
    ): MasterDriver[] {
      return masterIds.map((masterId, index) => {
        // Uniform by area, not by radius — `nearby-masters.benchmark.test.ts` explains why
        // (`sqrt(random())`, not `random()`, or every master piles up near the centre).
        const radiusM = START_SPREAD_M * Math.sqrt(Math.random());
        const bearing = Math.random() * 2 * Math.PI;
        const start = moveBy(CITY_CENTRE.latitude, CITY_CENTRE.longitude, radiusM, bearing);
        const onOrder = index < onOrderCount;

        return {
          masterId,
          accessToken: accessTokens[index] ?? '',
          onOrder,
          floorRangeSeconds: onOrder ? ON_ORDER_FLOOR_SECONDS : IDLE_FLOOR_SECONDS,
          distanceFilterM: onOrder ? ON_ORDER_DISTANCE_FILTER_M : IDLE_DISTANCE_FILTER_M,
          latitude: start.latitude,
          longitude: start.longitude,
        };
      });
    }

    beforeAll(async () => {
      const baseDbUrl = parseEnv(process.env).database.url;
      database = await createThrowawayDatabase(baseDbUrl);
      await runMigrations(database.url);
      await runSeed(database.url);

      set('DATABASE_URL', database.url);
      // The per-user half is the real budget this endpoint enforces in
      // production (`docs/architecture/realtime-architecture.md` § The budget
      // is enforced, not advised); raised here only so a benchmark master
      // reporting every 10-15 s for several minutes does not trip it before
      // the run finishes measuring the write path it exists to protect.
      //
      // The per-IP half is raised to the schema's own ceiling
      // (`boundedInt(_, 1, 10_000)` in `env.schema.ts`) and still cannot be
      // raised past it. In production this is loose on purpose — masters sit
      // behind carrier NATs, many phones per address — but this generator
      // drives every simulated master from one process's one loopback
      // address, which no real deployment does. At high master counts this
      // ceiling is expected to bind before the run ends; `429 RATE_LIMITED`
      // is treated as an expected status for exactly that reason, not folded
      // into "unexpected errors" below.
      set('MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR', '10000');
      set('MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR', '10000');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      // Before `listen()`, not after: Nest attaches the socket.io server as it
      // starts listening (`realtime-io.adapter.ts`), and the fan-out path a
      // portion of these masters exercise calls through the gateway this
      // installs.
      app.useWebSocketAdapter(new RealtimeIoAdapter(app));
      await app.listen(0, '127.0.0.1');
      baseUrl = await app.getUrl();

      db = app.get<Database>(DATABASE_CONNECTION);
      redis = app.get<Redis>(REDIS_CLIENT);

      pool = new Pool({ connectionString: database.url });
      pool.on('error', () => undefined);

      const { rows } = await pool.query<{ id: string }>(
        `select id from services where is_active order by id limit 1`,
      );
      const found = rows[0]?.id;
      if (found === undefined) {
        throw new Error('The seeded catalogue has no active service.');
      }
      serviceId = found;
    }, 600_000);

    afterAll(async () => {
      await pool.end();
      await app.close();
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await database.drop();
    }, 120_000);

    it(
      `sustains ingest at ${MASTER_COUNT} masters within ${P95_BUDGET_MS} ms p95`,
      async () => {
        const onOrderCount = Math.max(1, Math.round(MASTER_COUNT * ON_ORDER_FRACTION));

        const { userIds, masterIds } = await seedMasters(MASTER_COUNT);
        await seedActiveOrders(masterIds.slice(0, onOrderCount));

        const sessions = app.get(SessionsService);
        const accessTokens = await mintTokens(userIds, sessions);
        const drivers = buildDrivers(masterIds, accessTokens, onOrderCount);

        const pgVersion = (await pool.query<{ server_version: string }>('show server_version'))
          .rows[0]?.server_version;
        const redisInfo = await redis.info('server');
        const redisVersion = /redis_version:(\S+)/.exec(redisInfo)?.[1] ?? 'unknown';

        const warmupEndAt = Date.now() + WARMUP_SECONDS * 1_000;
        const stopAt = warmupEndAt + DURATION_SECONDS * 1_000;

        const samples: number[] = [];
        const statusCounts = new Map<number, number>();
        const semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);

        let peakWaitingCount = 0;
        const poolSampler = setInterval(() => {
          const waiting = db.$client.waitingCount;
          if (waiting > peakWaitingCount) {
            peakWaitingCount = waiting;
          }
        }, 50);

        const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
        eventLoopDelay.enable();

        async function drive(driver: MasterDriver): Promise<void> {
          // Staggered so `MASTER_COUNT` drivers do not all fire their first
          // report in the same instant — a real fleet does not boot in sync.
          await sleep(Math.random() * driver.floorRangeSeconds[1] * 1_000);

          while (Date.now() < stopAt) {
            const bearing = Math.random() * 2 * Math.PI;
            const stepM = Math.random() * driver.distanceFilterM;
            const moved = moveBy(driver.latitude, driver.longitude, stepM, bearing);
            driver.latitude = moved.latitude;
            driver.longitude = moved.longitude;

            const requestStartedAt = Date.now();
            const startedPerf = performance.now();
            const release = await semaphore.acquire();
            try {
              const res = await fetch(`${baseUrl}/masters/me/location`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${driver.accessToken}`,
                },
                body: JSON.stringify({ latitude: driver.latitude, longitude: driver.longitude }),
              });
              await res.arrayBuffer();
              const elapsedMs = performance.now() - startedPerf;

              if (requestStartedAt >= warmupEndAt) {
                samples.push(elapsedMs);
                statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);
              }
            } finally {
              release();
            }

            await sleep(randomInRange(driver.floorRangeSeconds) * 1_000);
          }
        }

        await Promise.all(drivers.map((driver) => drive(driver)));

        eventLoopDelay.disable();
        clearInterval(poolSampler);

        const sorted = [...samples].sort((a, b) => a - b);
        const p50 = percentile(sorted, 0.5);
        const p95 = percentile(sorted, 0.95);
        const p99 = percentile(sorted, 0.99);
        const max = sorted[sorted.length - 1] ?? Number.NaN;
        const achievedRps = samples.length / DURATION_SECONDS;

        const statusLines = [...statusCounts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([status, count]) => `    ${String(status)}: ${String(count)}`)
          .join('\n');

        const cpu = os.cpus()[0];

        process.stdout.write(
          [
            '',
            'master-location ingest benchmark',
            `  masters:              ${MASTER_COUNT} (${onOrderCount} on an active order)`,
            `  warmup:               ${WARMUP_SECONDS} s`,
            `  duration:             ${DURATION_SECONDS} s`,
            `  requests measured:    ${samples.length}`,
            `  achieved rps:         ${achievedRps.toFixed(2)}`,
            `  p50:                  ${p50.toFixed(2)} ms`,
            `  p95:                  ${p95.toFixed(2)} ms`,
            `  p99:                  ${p99.toFixed(2)} ms`,
            `  max:                  ${max.toFixed(2)} ms`,
            '  responses by status:',
            statusLines,
            `  peak pool waitingCount: ${String(peakWaitingCount)}`,
            '  generator event-loop delay:',
            `    mean: ${(eventLoopDelay.mean / 1e6).toFixed(2)} ms`,
            `    p95:  ${(eventLoopDelay.percentile(95) / 1e6).toFixed(2)} ms`,
            `    max:  ${(eventLoopDelay.max / 1e6).toFixed(2)} ms`,
            `  cpu:                  ${cpu?.model ?? 'unknown'} x${String(os.cpus().length)}`,
            `  total memory:         ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
            `  postgres:             ${pgVersion ?? 'unknown'}`,
            `  redis:                ${redisVersion}`,
            '',
          ].join('\n'),
        );

        // 429 is the one status this run expects at high master counts (see the
        // comment on the per-IP override in `beforeAll`); anything else is a
        // failure the write path itself produced.
        const unexpected = [...statusCounts.entries()].filter(
          ([status]) => status !== 200 && status !== 429,
        );

        expect(samples.length).toBeGreaterThan(0);
        expect(unexpected).toStrictEqual([]);
        expect(p95).toBeLessThan(P95_BUDGET_MS);
      },
      (WARMUP_SECONDS + DURATION_SECONDS + 120) * 1_000,
    );
  },
);
