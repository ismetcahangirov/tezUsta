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
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Order creation and standard authenticated reads under concurrent load
 * (issue #291, EPIC 16).
 *
 * ```bash
 * docker compose up -d
 * ORDERS_BENCHMARK=1 pnpm --filter api exec vitest run test/orders.benchmark.test.ts
 * ```
 *
 * **Opt-in, for `nearby-masters.benchmark.test.ts`'s reason.** Every
 * correctness claim about order creation, cancellation and reads is asserted
 * unconditionally in `orders.e2e.test.ts`, `order-cancellation.e2e.test.ts`
 * and `orders.reads.e2e.test.ts`; this file asserts a *latency budget* and has
 * to seed a realistic history to mean anything — tens of thousands of rows
 * that would otherwise be paid on every `pnpm test`, on whatever hardware CI
 * happened to schedule, where the number would measure the runner rather than
 * the endpoint.
 *
 * ## What each scenario measures
 *
 * **Scenario 1 — order creation.** `ORDERS_BENCHMARK_CREATE_CUSTOMERS`
 * (default 200) real customers, each with a saved address, fire
 * `POST /orders` at once, over real HTTP (Node's global `fetch`) against the
 * real `AppModule` listening on a real port — validation, the open-order cap
 * (#276), the address/service lookup, the `DRAFT → SEARCHING` insert, the
 * status-history row and the dispatch enqueue all happen inside the measured
 * response, because `OrdersService.create` awaits `dispatch.started()` before
 * it returns. The dispatch **worker** is running throughout, exactly as a
 * normal API replica does (`QUEUE_WORKER_MODE` is left at its default) — this
 * file does not turn it off or mock it away. Each customer then cancels their
 * own order; the cancel is fired but its latency is **excluded** from the
 * creation figure, and exists only so the open-order cap does not turn
 * customer 4 into a 409.
 *
 * **What this scenario does not seed: masters.** No master is eligible for
 * any of these orders, so every dispatch wave runs its real nearby-masters
 * query against an empty candidate set and the search eventually times out in
 * the background. The enqueue cost — the thing `POST /orders` actually pays
 * for, synchronously — is identical whether a master exists or not; what
 * would differ is the wave's own query cost, which is
 * `nearby-masters.benchmark.test.ts`'s subject, not this file's.
 *
 * **Scenario 2 — standard reads.** A database seeded, set-based, with
 * `ORDERS_BENCHMARK_HISTORY_ORDERS` (default 50,000) orders across
 * `ORDERS_BENCHMARK_HISTORY_CUSTOMERS` customers and
 * `ORDERS_BENCHMARK_HISTORY_MASTERS` masters — bulk `INSERT ... SELECT ...
 * FROM generate_series`, not a loop of round trips. A pool of real customer
 * and master accounts then fire a mixed load of `GET /orders` (own order
 * list), `GET /orders/:id` (one order), `GET /services/categories` (the
 * public catalogue) and `GET /masters/me/jobs/current` (the master's engaged
 * job), at the ratio {@link READ_MIX} states, all through real HTTP with real
 * tokens.
 *
 * ## Rate limits
 *
 * `POST /orders` (`order-creation`) and `POST /orders/:id/transitions`
 * (`order-transition`) are rate-limited per user *and* per IP
 * (`docs/engineering/security.md`), and every request in this file comes from
 * the same loopback address. `GET /masters/me/jobs/current` (`offer-feed`) is
 * the one read route with a limit. **Raised to the schema's own ceiling here,
 * and only here** — this file does not touch production defaults, it just
 * refuses to let the very budget this issue exists to measure be the thing
 * that answers 429.
 *
 * ## Budgets
 *
 * Each scenario fails if its p95 exceeds `docs/engineering/performance.md`'s
 * number — 300 ms for creation, 200 ms for a standard read — overridable by
 * `ORDERS_BENCHMARK_CREATE_P95_BUDGET_MS` / `ORDERS_BENCHMARK_READ_P95_BUDGET_MS`.
 *
 * ## Every knob
 *
 * `ORDERS_BENCHMARK_CREATE_CUSTOMERS` (200), `ORDERS_BENCHMARK_CREATE_CONCURRENCY`
 * (= the above), `ORDERS_BENCHMARK_HISTORY_ORDERS` (50,000),
 * `ORDERS_BENCHMARK_HISTORY_CUSTOMERS` (2,000), `ORDERS_BENCHMARK_HISTORY_MASTERS`
 * (500), `ORDERS_BENCHMARK_READ_CUSTOMER_ACCOUNTS` (200),
 * `ORDERS_BENCHMARK_READ_MASTER_ACCOUNTS` (200, clamped to the masters seeded),
 * `ORDERS_BENCHMARK_READ_REQUESTS` (2,000), `ORDERS_BENCHMARK_READ_CONCURRENCY`
 * (50).
 */

// ---------------------------------------------------------------------------
// Shared helpers — used by both scenarios below.
// ---------------------------------------------------------------------------

const enabled = process.env.ORDERS_BENCHMARK === '1';

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+9940${String(phoneCounter).padStart(9, '0')}`;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

/**
 * Runs `count` tasks with at most `concurrency` in flight at once — the
 * bounded-concurrency pool `docs/engineering/performance.md`'s "no
 * uncontrolled polling" cousin asks of a load generator: enough parallelism to
 * mean "concurrent load", not so much that the generator's own event loop
 * becomes the bottleneck being measured.
 */
async function runBounded<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(count) as T[];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) {
        return;
      }
      results[index] = await task(index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, count));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

interface CallResult {
  readonly status: number;
  readonly durationMs: number;
  readonly json: unknown;
}

/** One real HTTP round trip through Node's global `fetch` — no test client, no mock. */
async function call(
  method: 'GET' | 'POST',
  url: string,
  accessToken?: string,
  body?: unknown,
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (accessToken !== undefined) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const durationMs = performance.now() - startedAt;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, durationMs, json };
  } catch {
    // A connection-level failure (refused, reset, timed out) — tallied as
    // status 0 rather than thrown, so one bad request does not abort the
    // whole batch the percentiles are computed over.
    return { status: 0, durationMs: performance.now() - startedAt, json: undefined };
  }
}

interface EventLoopDelaySummary {
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

function measureEventLoopDelay(): () => EventLoopDelaySummary {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  return () => {
    histogram.disable();
    const summary = {
      meanMs: histogram.mean / 1e6,
      p50Ms: histogram.percentile(50) / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
      maxMs: histogram.max / 1e6,
    };
    histogram.reset();
    return summary;
  };
}

/** Prints the standard report and returns p95, so the caller can assert on it. */
function report(
  label: string,
  samples: readonly number[],
  statusCounts: ReadonlyMap<number, number>,
  wallClockMs: number,
  eventLoopDelay: EventLoopDelaySummary,
): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1] ?? Number.NaN;
  const rps = samples.length / (wallClockMs / 1000);

  const errorLines = [...statusCounts.entries()]
    .filter(([status]) => status < 200 || status >= 300)
    .sort((a, b) => a[0] - b[0])
    .map(([status, count]) => `    ${status === 0 ? 'network-error' : String(status)}: ${count}`);

  process.stdout.write(
    [
      '',
      label,
      `  requests:                ${samples.length}`,
      `  wall clock:              ${(wallClockMs / 1000).toFixed(2)} s`,
      `  rps:                     ${rps.toFixed(1)}`,
      `  p50:                     ${p50.toFixed(2)} ms`,
      `  p95:                     ${p95.toFixed(2)} ms`,
      `  p99:                     ${p99.toFixed(2)} ms`,
      `  max:                     ${max.toFixed(2)} ms`,
      `  errors by status:        ${errorLines.length === 0 ? 'none' : ''}`,
      ...errorLines,
      '  generator event-loop delay:',
      `    mean:                   ${eventLoopDelay.meanMs.toFixed(2)} ms`,
      `    p50:                    ${eventLoopDelay.p50Ms.toFixed(2)} ms`,
      `    p99:                    ${eventLoopDelay.p99Ms.toFixed(2)} ms`,
      `    max:                    ${eventLoopDelay.maxMs.toFixed(2)} ms`,
      '',
    ].join('\n'),
  );

  return p95;
}

function tally(counts: Map<number, number>, status: number): void {
  counts.set(status, (counts.get(status) ?? 0) + 1);
}

async function printEnvironmentBanner(pool: Pool, redis: Redis): Promise<void> {
  const cpus = os.cpus();
  const [{ rows: pgRows }, redisInfo] = await Promise.all([
    pool.query<{ version: string }>('select version()'),
    redis.info('server'),
  ]);
  const redisVersion = /redis_version:([^\r\n]+)/.exec(redisInfo)?.[1] ?? 'unknown';

  process.stdout.write(
    [
      '',
      'environment',
      `  node:                    ${process.version}`,
      `  platform:                ${os.platform()} ${os.arch()}`,
      `  cpus:                    ${String(cpus.length)}x ${cpus[0]?.model ?? 'unknown'}`,
      `  total memory:            ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
      `  postgres:                ${pgRows[0]?.version ?? 'unknown'}`,
      `  redis:                   ${redisVersion}`,
      '',
    ].join('\n'),
  );
}

const CREATE_P95_BUDGET_MS = Number(process.env.ORDERS_BENCHMARK_CREATE_P95_BUDGET_MS ?? 300);
const READ_P95_BUDGET_MS = Number(process.env.ORDERS_BENCHMARK_READ_P95_BUDGET_MS ?? 200);

// ---------------------------------------------------------------------------
// Scenario 1 — order creation under concurrent load.
// ---------------------------------------------------------------------------

const CREATE_CUSTOMERS = Number(process.env.ORDERS_BENCHMARK_CREATE_CUSTOMERS ?? 200);
const CREATE_CONCURRENCY = Number(
  process.env.ORDERS_BENCHMARK_CREATE_CONCURRENCY ?? CREATE_CUSTOMERS,
);
const CREATE_DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir — bench sifariş.';
const CREATE_CANCEL_REASON = 'Yük testi — sifariş avtomatik ləğv edilir.';

describe.runIf(enabled)('order creation under concurrent load (issue #291)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let baseUrl: string;
  let pool: Pool;
  let redis: Redis;
  let sessionsService: SessionsService;
  let serviceId: string;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeAll(async () => {
    const url = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(url);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);

    // Every request in this file comes from one loopback address, and the
    // whole point of this scenario is C of them at once — the production
    // ceiling (`docs/engineering/security.md`), raised only for this run, so
    // the budget under measurement is not the thing that answers 429.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '10000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '10000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '10000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '10000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    sessionsService = app.get(SessionsService);
    redis = app.get<Redis>(REDIS_CLIENT);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 1`,
    );
    const seeded = rows[0]?.id;
    if (seeded === undefined) {
      throw new Error('the seed should have provided at least one active service');
    }
    serviceId = seeded;

    await printEnvironmentBanner(pool, redis);
  }, 120_000);

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

  interface Customer {
    readonly accessToken: string;
    readonly addressId: string;
  }

  /** A real user, a real customer profile and a real saved address — over HTTP, unmeasured setup. */
  async function seedCustomer(): Promise<Customer> {
    const created = await pool.query<{ id: string }>(
      `insert into users (id, phone_e164) values (gen_random_uuid(), $1) returning id`,
      [nextPhone()],
    );
    const userId = created.rows[0]?.id;
    if (userId === undefined) {
      throw new Error('failed to seed a user');
    }
    const pair = await sessionsService.startSession({ userId });

    const profile = await call('POST', `${baseUrl}/customers`, pair.accessToken, {
      displayName: 'Bench müştəri',
    });
    if (profile.status !== 201) {
      throw new Error(`failed to seed a customer profile: ${String(profile.status)}`);
    }

    const address = await call('POST', `${baseUrl}/addresses`, pair.accessToken, {
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    if (address.status !== 201) {
      throw new Error(`failed to seed an address: ${String(address.status)}`);
    }

    return { accessToken: pair.accessToken, addressId: (address.json as { id: string }).id };
  }

  it(`creates an order within ${String(CREATE_P95_BUDGET_MS)} ms at p95, for ${String(CREATE_CUSTOMERS)} concurrent customers`, async () => {
    const customers = await runBounded(CREATE_CUSTOMERS, CREATE_CONCURRENCY, () => seedCustomer());

    const stopEventLoopMonitor = measureEventLoopDelay();
    const createStartedAt = performance.now();

    const createResults = await runBounded(CREATE_CUSTOMERS, CREATE_CONCURRENCY, (index) =>
      call('POST', `${baseUrl}/orders`, customers[index]?.accessToken, {
        serviceId,
        addressId: customers[index]?.addressId,
        description: CREATE_DESCRIPTION,
        idempotencyKey: randomUUID(),
      }),
    );

    const createWallClockMs = performance.now() - createStartedAt;
    const eventLoopDelay = stopEventLoopMonitor();

    const createStatusCounts = new Map<number, number>();
    const createSamples: number[] = [];
    const orderIds: (string | undefined)[] = [];
    for (const result of createResults) {
      tally(createStatusCounts, result.status);
      createSamples.push(result.durationMs);
      orderIds.push(
        result.status === 201 ? (result.json as { id: string } | undefined)?.id : undefined,
      );
    }

    // The cancel exists to keep the open-order cap out of a repeat run's
    // way, and it is fired for every order that was actually created — its
    // own latency is reported for visibility but is not what this test
    // asserts on.
    const cancelStartedAt = performance.now();
    const cancelResults = await runBounded(CREATE_CUSTOMERS, CREATE_CONCURRENCY, (index) => {
      const orderId = orderIds[index];
      const accessToken = customers[index]?.accessToken;
      if (orderId === undefined || accessToken === undefined) {
        return Promise.resolve({ status: 0, durationMs: 0, json: undefined });
      }
      return call('POST', `${baseUrl}/orders/${orderId}/transitions`, accessToken, {
        to: 'CANCELLED',
        reason: CREATE_CANCEL_REASON,
      });
    });
    const cancelWallClockMs = performance.now() - cancelStartedAt;

    const cancelStatusCounts = new Map<number, number>();
    const cancelSamples: number[] = [];
    for (const result of cancelResults) {
      tally(cancelStatusCounts, result.status);
      cancelSamples.push(result.durationMs);
    }

    const createP95 = report(
      'order creation — POST /orders',
      createSamples,
      createStatusCounts,
      createWallClockMs,
      eventLoopDelay,
    );
    // Reported without its own event-loop reading — the cancel is excluded
    // from the figure this test exists to measure, and monitoring it a
    // second time would only restate the same generator.
    report(
      'order cancellation — POST /orders/:id/transitions (excluded from the budget above)',
      cancelSamples,
      cancelStatusCounts,
      cancelWallClockMs,
      eventLoopDelay,
    );

    const created = createResults.filter((result) => result.status === 201).length;
    expect(created).toBeGreaterThan(0);
    expect(createP95).toBeLessThan(CREATE_P95_BUDGET_MS);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Scenario 2 — standard authenticated reads under concurrent load.
// ---------------------------------------------------------------------------

const HISTORY_ORDERS = Number(process.env.ORDERS_BENCHMARK_HISTORY_ORDERS ?? 50_000);
const HISTORY_CUSTOMERS = Number(process.env.ORDERS_BENCHMARK_HISTORY_CUSTOMERS ?? 2_000);
const HISTORY_MASTERS = Number(process.env.ORDERS_BENCHMARK_HISTORY_MASTERS ?? 500);
const READ_CUSTOMER_ACCOUNTS = Math.min(
  Number(process.env.ORDERS_BENCHMARK_READ_CUSTOMER_ACCOUNTS ?? 200),
  HISTORY_CUSTOMERS,
);
const READ_MASTER_ACCOUNTS = Math.min(
  Number(process.env.ORDERS_BENCHMARK_READ_MASTER_ACCOUNTS ?? 200),
  HISTORY_MASTERS,
);
const READ_REQUESTS = Number(process.env.ORDERS_BENCHMARK_READ_REQUESTS ?? 2_000);
const READ_CONCURRENCY = Number(process.env.ORDERS_BENCHMARK_READ_CONCURRENCY ?? 50);
const BAKU_CENTRE = { latitude: 40.372613, longitude: 49.842717 };

/**
 * The stated mixed-read ratio: customer order list, one order, the public
 * catalogue, the master's current job — weights, not percentages, summing to
 * whatever {@link READ_MIX_TOTAL} is.
 */
const READ_MIX = { list: 4, one: 3, catalogue: 1, masterJob: 2 } as const;
const READ_MIX_TOTAL = READ_MIX.list + READ_MIX.one + READ_MIX.catalogue + READ_MIX.masterJob;

type ReadKind = keyof typeof READ_MIX;

function pickReadKind(random: number): ReadKind {
  const scaled = random * READ_MIX_TOTAL;
  if (scaled < READ_MIX.list) {
    return 'list';
  }
  if (scaled < READ_MIX.list + READ_MIX.one) {
    return 'one';
  }
  if (scaled < READ_MIX.list + READ_MIX.one + READ_MIX.catalogue) {
    return 'catalogue';
  }
  return 'masterJob';
}

describe.runIf(enabled)('standard authenticated reads under concurrent load (issue #291)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let baseUrl: string;
  let pool: Pool;
  let redis: Redis;
  let sessionsService: SessionsService;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  interface ReadCustomer {
    readonly accessToken: string;
    readonly orderId: string;
  }

  const readCustomers: ReadCustomer[] = [];
  const readMasterTokens: string[] = [];

  beforeAll(async () => {
    const url = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(url);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    // The one read route with a limit (`offer-feed`, shared with the master
    // job feed's own budget) — raised here for the same reason as scenario
    // 1's, and nowhere else.
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR', '10000');
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_IP_HOUR', '10000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    sessionsService = app.get(SessionsService);
    redis = app.get<Redis>(REDIS_CLIENT);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows: serviceRows } = await pool.query<{ id: string }>(
      `select id from services where is_active`,
    );
    const serviceIds = serviceRows.map((row) => row.id);
    if (serviceIds.length === 0) {
      throw new Error('the seed should have provided at least one active service');
    }

    await seedHistory(serviceIds);
    await printEnvironmentBanner(pool, redis);
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

  /**
   * The whole database this scenario reads from, written set-based: bulk
   * `unnest`/`generate_series` inserts, not a loop of round trips
   * (`docs/engineering/performance.md`: "measure before optimising" applies
   * to the seed too — a loop here would make setup the slowest part of the
   * file it is supposed to be scaffolding for).
   */
  async function seedHistory(serviceIds: readonly string[]): Promise<void> {
    // --- customers: a user, a profile and one saved address each ---------
    const customerUserIds = Array.from({ length: HISTORY_CUSTOMERS }, () => randomUUID());
    const customerIds = Array.from({ length: HISTORY_CUSTOMERS }, () => randomUUID());
    const addressIds = Array.from({ length: HISTORY_CUSTOMERS }, () => randomUUID());
    const customerPhones = Array.from({ length: HISTORY_CUSTOMERS }, () => nextPhone());
    const customerNames = customerIds.map((_, index) => `Bench müştəri ${String(index)}`);
    const addressLabels = addressIds.map(() => 'Bench ünvan');
    const lons = addressIds.map(() => BAKU_CENTRE.longitude + (Math.random() - 0.5) * 0.3);
    const lats = addressIds.map(() => BAKU_CENTRE.latitude + (Math.random() - 0.5) * 0.3);

    await pool.query(
      `insert into users (id, phone_e164) select * from unnest($1::uuid[], $2::text[])`,
      [customerUserIds, customerPhones],
    );
    await pool.query(
      `insert into customers (id, user_id, display_name)
       select * from unnest($1::uuid[], $2::uuid[], $3::text[])`,
      [customerIds, customerUserIds, customerNames],
    );
    await pool.query(
      `insert into addresses (id, customer_id, formatted_address, position, is_default)
       select a, c, label, ST_SetSRID(ST_MakePoint(lon, lat), 4326), true
         from unnest($1::uuid[], $2::uuid[], $3::text[], $4::double precision[], $5::double precision[])
           as t(a, c, label, lon, lat)`,
      [addressIds, customerIds, addressLabels, lons, lats],
    );

    // --- masters: a user and a profile each, no location or presence ------
    // (nothing this scenario reads touches nearby-masters or presence).
    const masterUserIds = Array.from({ length: HISTORY_MASTERS }, () => randomUUID());
    const masterIds = Array.from({ length: HISTORY_MASTERS }, () => randomUUID());
    const masterPhones = Array.from({ length: HISTORY_MASTERS }, () => nextPhone());
    const masterNames = masterIds.map((_, index) => `Bench usta ${String(index)}`);

    await pool.query(
      `insert into users (id, phone_e164) select * from unnest($1::uuid[], $2::text[])`,
      [masterUserIds, masterPhones],
    );
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status, is_available)
       select m, u, name, 'active', true
         from unnest($1::uuid[], $2::uuid[], $3::text[]) as t(m, u, name)`,
      [masterIds, masterUserIds, masterNames],
    );

    // --- the bulk order history: terminal statuses only, set-based --------
    // `orders_one_active_per_master` (schema/orders.ts) permits at most one
    // engaged order per master, so the bulk history stays entirely in
    // statuses that index does not cover — the handful of engaged jobs below
    // get their own one-row-per-master insert instead.
    await pool.query(
      `insert into orders (
         id, customer_id, address_id, service_id, master_id, status, description,
         price_minor, idempotency_key, accepted_at, created_at, updated_at
       )
       select
         gen_random_uuid(),
         cust.customer_id,
         cust.address_id,
         svc.id,
         case when hm.has_master then mast.master_id else null end,
         st.status::order_status,
         'Bench tarixi sifariş ' || g,
         case when hm.has_master then 3000 + (random() * 9000)::int else null end,
         gen_random_uuid()::text,
         case when hm.has_master then created.at else null end,
         created.at,
         created.at
       from generate_series(1, $1) g
       cross join lateral (
         select now() - make_interval(days => (random() * 90)::int, secs => (random() * 86400)::int) as at
       ) created
       cross join lateral (
         select ($2::uuid[])[1 + floor(random() * $3)::int] as customer_id,
                ($4::uuid[])[1 + floor(random() * $3)::int] as address_id
       ) cust
       cross join lateral (
         select ($5::uuid[])[1 + floor(random() * $6)::int] as id
       ) svc
       cross join lateral (select random() < 0.7 as has_master) hm
       cross join lateral (
         select case
           when hm.has_master
             then (array['COMPLETED', 'COMPLETED', 'PAID', 'DISPUTED', 'RESOLVED'])[1 + floor(random() * 5)::int]
           else (array['CANCELLED', 'CANCELLED', 'NO_MASTER_FOUND', 'SEARCHING'])[1 + floor(random() * 4)::int]
         end as status
       ) st
       cross join lateral (
         select case when hm.has_master then ($7::uuid[])[1 + floor(random() * $8)::int] else null end as master_id
       ) mast`,
      [
        HISTORY_ORDERS,
        customerIds,
        HISTORY_CUSTOMERS,
        addressIds,
        serviceIds,
        serviceIds.length,
        masterIds,
        HISTORY_MASTERS,
      ],
    );

    // --- the engaged jobs: one ACCEPTED order and offer per read-master ---
    const engagedOrderIds = Array.from({ length: READ_MASTER_ACCOUNTS }, () => randomUUID());
    const engagedMasterIds = masterIds.slice(0, READ_MASTER_ACCOUNTS);
    const engagedCustomerIds = Array.from(
      { length: READ_MASTER_ACCOUNTS },
      (_, index) => customerIds[index % HISTORY_CUSTOMERS] ?? customerIds[0],
    );
    const engagedAddressIds = Array.from(
      { length: READ_MASTER_ACCOUNTS },
      (_, index) => addressIds[index % HISTORY_CUSTOMERS] ?? addressIds[0],
    );
    const engagedServiceIds = Array.from(
      { length: READ_MASTER_ACCOUNTS },
      (_, index) => serviceIds[index % serviceIds.length] ?? serviceIds[0],
    );

    await pool.query(
      `insert into orders (
         id, customer_id, address_id, service_id, master_id, status, description,
         price_minor, idempotency_key, accepted_at
       )
       select o, c, a, s, m, 'ACCEPTED', 'Bench aktiv iş', 6700, o::text, now()
         from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
           as t(o, c, a, s, m)`,
      [engagedOrderIds, engagedCustomerIds, engagedAddressIds, engagedServiceIds, engagedMasterIds],
    );
    await pool.query(
      `insert into order_offers (
         id, order_id, master_id, round, radius_m, distance_m, status, responded_at, expires_at
       )
       select gen_random_uuid(), o, m, 1, 3000, 1000, 'accepted', now(), now() + interval '1 hour'
         from unnest($1::uuid[], $2::uuid[]) as t(o, m)`,
      [engagedOrderIds, engagedMasterIds],
    );

    await pool.query('analyze orders');
    await pool.query('analyze customers');
    await pool.query('analyze addresses');
    await pool.query('analyze masters');
    await pool.query('analyze order_offers');

    // --- real tokens: a subset of customers, and every engaged master -----
    const { rows: oneOrderPerCustomer } = await pool.query<{
      customer_id: string;
      id: string;
    }>(
      `select distinct on (customer_id) customer_id, id
         from orders
        where customer_id = any($1::uuid[])
        order by customer_id, created_at desc`,
      [customerIds.slice(0, READ_CUSTOMER_ACCOUNTS)],
    );
    const orderIdByCustomerId = new Map(
      oneOrderPerCustomer.map((row) => [row.customer_id, row.id]),
    );

    for (let index = 0; index < READ_CUSTOMER_ACCOUNTS; index += 1) {
      const customerId = customerIds[index];
      const userId = customerUserIds[index];
      const orderId = customerId === undefined ? undefined : orderIdByCustomerId.get(customerId);
      if (userId === undefined || orderId === undefined) {
        continue;
      }
      const pair = await sessionsService.startSession({ userId });
      readCustomers.push({ accessToken: pair.accessToken, orderId });
    }

    // The master read route is `@Roles('master')`, resolved by
    // `AuthenticationGuard` from `user_roles` — never from the token's own
    // claim (`roles.guard.ts`) — so seeding the masters table alone is not
    // enough; the grant has to exist before `startSession` mints the token.
    const engagedUserIds = masterUserIds.slice(0, READ_MASTER_ACCOUNTS);
    await pool.query(
      `insert into user_roles (user_id, role) select u, 'master' from unnest($1::uuid[]) as t(u)`,
      [engagedUserIds],
    );
    for (const userId of engagedUserIds) {
      const pair = await sessionsService.startSession({ userId });
      readMasterTokens.push(pair.accessToken);
    }
  }

  it(`answers a standard read within ${String(READ_P95_BUDGET_MS)} ms at p95, for ${String(READ_REQUESTS)} requests at concurrency ${String(READ_CONCURRENCY)}`, async () => {
    expect(readCustomers.length).toBeGreaterThan(0);
    expect(readMasterTokens.length).toBeGreaterThan(0);

    const stopEventLoopMonitor = measureEventLoopDelay();
    const startedAt = performance.now();

    const results = await runBounded(READ_REQUESTS, READ_CONCURRENCY, () => {
      const kind = pickReadKind(Math.random());

      if (kind === 'list') {
        const customer = readCustomers[Math.floor(Math.random() * readCustomers.length)];
        return call('GET', `${baseUrl}/orders`, customer?.accessToken);
      }
      if (kind === 'one') {
        const customer = readCustomers[Math.floor(Math.random() * readCustomers.length)];
        return call('GET', `${baseUrl}/orders/${customer?.orderId}`, customer?.accessToken);
      }
      if (kind === 'catalogue') {
        return call('GET', `${baseUrl}/services/categories`);
      }
      const token = readMasterTokens[Math.floor(Math.random() * readMasterTokens.length)];
      return call('GET', `${baseUrl}/masters/me/jobs/current`, token);
    });

    const wallClockMs = performance.now() - startedAt;
    const eventLoopDelay = stopEventLoopMonitor();

    const statusCounts = new Map<number, number>();
    const samples: number[] = [];
    for (const result of results) {
      tally(statusCounts, result.status);
      samples.push(result.durationMs);
    }

    const p95 = report(
      `mixed reads — GET /orders : GET /orders/:id : GET /services/categories : GET /masters/me/jobs/current = ${String(READ_MIX.list)}:${String(READ_MIX.one)}:${String(READ_MIX.catalogue)}:${String(READ_MIX.masterJob)}`,
      samples,
      statusCounts,
      wallClockMs,
      eventLoopDelay,
    );

    const ok = results.filter((result) => result.status >= 200 && result.status < 300).length;
    expect(ok).toBeGreaterThan(0);
    expect(p95).toBeLessThan(READ_P95_BUDGET_MS);
  }, 600_000);
});
