import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
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
import { nearbyMastersQuery } from '../src/modules/masters/nearby-masters.repository';
import { NearbyMastersService } from '../src/modules/masters/nearby-masters.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The p95 measurement for the nearby-eligible-masters query (issue #100).
 *
 * ```bash
 * docker compose up -d
 * NEARBY_MASTERS_BENCHMARK=1 pnpm --filter api exec vitest run test/nearby-masters.benchmark.test.ts
 * ```
 *
 * **Opt-in, and that is a deliberate exception to "a test that skips is worse
 * than none" (CLAUDE.md §13).** That rule is about correctness tests quietly
 * not running; every correctness claim about this query is asserted
 * unconditionally in `nearby-masters.integration.test.ts`, which fails loudly
 * with no database. This file asserts a *latency budget*, and it has to seed
 * {@link MASTER_COUNT} masters and six positions each to mean anything — around
 * a minute of work that would otherwise be paid on every `pnpm test`, on
 * whatever hardware CI happened to schedule, where the number would measure the
 * runner rather than the query.
 *
 * When it does run, it is a real test: it fails if p95 exceeds
 * {@link P95_BUDGET_MS}.
 *
 * ## What is being measured
 *
 * `NearbyMastersService.findEligible` end to end — the PostGIS stage and the
 * Redis stage together, from a warm connection pool, one query at a time, no
 * concurrency. That is the operation dispatch performs per broadcast round.
 *
 * ## The dataset
 *
 * A deliberately unfavourable Baku: **every** seeded master is `active`,
 * `is_available`, offers the service being searched for, and is live in Redis.
 * A real city divides masters across 33 catalogue services and several
 * verification states, so the candidate set here is far larger than one
 * service would really produce — which is the point, since a benchmark that
 * flatters the query is not evidence.
 *
 * Positions are uniform **by area** (radius scaled by `sqrt(random())`, not by
 * `random()`, which would pile everybody onto the search point), spread over
 * {@link CITY_RADIUS_M}, with six reports each over the last ten minutes so
 * that the freshness bound has a trail to discard rather than a single row to
 * find.
 *
 * Every search point is jittered within a kilometre of the city centre, so the
 * figure is not one cached plan answering one identical query.
 */

const MASTER_COUNT = Number(process.env.NEARBY_MASTERS_BENCHMARK_MASTERS ?? 10_000);
const POSITIONS_PER_MASTER = 6;
const CITY_RADIUS_M = 15_000;
const SEARCH_RADIUS_M = 3_000;
const ITERATIONS = Number(process.env.NEARBY_MASTERS_BENCHMARK_ITERATIONS ?? 200);
const WARMUP = 20;
const P95_BUDGET_MS = 100;

const PRESENCE_TTL_SECONDS = 180;
/**
 * The dispatch freshness bound, pinned to its default (ADR-0026) rather than
 * inherited, so the figure below is not silently re-measured by an operator's
 * `.env`. Six reports 100 s apart means roughly half the trail is inside it —
 * which is the point: the query has rows to discard, not one row to find.
 */
const MAX_POSITION_AGE_SECONDS = 300;
const CITY_CENTRE = { latitude: 40.372613, longitude: 49.842717 };

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

const enabled = process.env.NEARBY_MASTERS_BENCHMARK === '1';

describe.runIf(enabled)('nearby eligible masters — latency (issue #100)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let redis: Redis;
  let db: Database;
  let nearby: NearbyMastersService;
  let serviceId: string;
  /** Every master this file created, so its Redis cleanup can be its own. */
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('RATE_LIMIT_KEY_SECRET', `nearby-masters-bench-${randomUUID()}`);
    set('PRESENCE_TTL_SECONDS', String(PRESENCE_TTL_SECONDS));
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', String(MAX_POSITION_AGE_SECONDS));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    redis = app.get(REDIS_CLIENT);
    db = app.get<Database>(DATABASE_CONNECTION);
    nearby = app.get(NearbyMastersService);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 1`,
    );
    const first = rows[0]?.id;
    if (first === undefined) {
      throw new Error('The seeded catalogue has no active service.');
    }
    serviceId = first;

    await seed();
  }, 600_000);

  afterAll(async () => {
    // Only the ids this file seeded. Redis is shared with every other suite
    // running in parallel, and `keys('presence:master:*')` would take theirs
    // with it — a presence bug reported from an unrelated file.
    for (let i = 0; i < seededMasterIds.length; i += 1000) {
      const batch = seededMasterIds.slice(i, i + 1000);
      if (batch.length > 0) {
        await redis.del(...batch.map((id) => `presence:master:${id}`));
      }
    }
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

  async function seed(): Promise<void> {
    await pool.query(
      `insert into users (id, phone_e164)
       select gen_random_uuid(), '+9946' || lpad(g::text, 8, '0')
         from generate_series(1, $1) g`,
      [MASTER_COUNT],
    );
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status, is_available)
       select gen_random_uuid(), u.id, 'Usta Bench', 'active', true
         from users u`,
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       select m.id, $1, 3000 + (random() * 9000)::int, true from masters m`,
      [serviceId],
    );
    // One home point per master, uniform by AREA, then a trail of reports
    // jittered around it — not six independent random points, which would put
    // one master in six different districts and make the spatial prefilter's
    // job artificially easy to get wrong.
    await pool.query(
      `with home as (
         select m.id as master_id,
                ST_Project(
                  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                  $3::double precision * sqrt(random()),
                  random() * 2 * pi()
                ) as point
           from masters m
       )
       insert into master_locations (id, master_id, position, recorded_at)
       select gen_random_uuid(),
              home.master_id,
              ST_Project(home.point, random() * 300, random() * 2 * pi())::geometry,
              now() - make_interval(secs => ((p - 1) * 100 + random() * 20)::int)
         from home
         cross join generate_series(1, $4) p`,
      [CITY_CENTRE.longitude, CITY_CENTRE.latitude, CITY_RADIUS_M, POSITIONS_PER_MASTER],
    );

    await pool.query('analyze users');
    await pool.query('analyze masters');
    await pool.query('analyze master_services');
    await pool.query('analyze master_locations');

    const { rows } = await pool.query<{ id: string }>('select id::text as id from masters');
    const pipeline = redis.pipeline();
    for (const row of rows) {
      seededMasterIds.push(row.id);
      pipeline.set(`presence:master:${row.id}`, '1', 'EX', PRESENCE_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  it(`answers within ${P95_BUDGET_MS} ms at p95`, async () => {
    const jittered = () => ({
      // ~1 km of jitter, so no two searches are the same query.
      latitude: CITY_CENTRE.latitude + (Math.random() - 0.5) * 0.018,
      longitude: CITY_CENTRE.longitude + (Math.random() - 0.5) * 0.024,
      serviceId,
      radiusM: SEARCH_RADIUS_M,
    });

    for (let i = 0; i < WARMUP; i += 1) {
      await nearby.findEligible(jittered());
    }

    const samples: number[] = [];
    let lastSize = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const query = jittered();
      const startedAt = performance.now();
      const found = await nearby.findEligible(query);
      samples.push(performance.now() - startedAt);
      lastSize = found.length;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);

    const { rows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from master_locations',
    );

    process.stdout.write(
      [
        '',
        'nearby-eligible-masters benchmark',
        `  masters:            ${MASTER_COUNT}`,
        `  location rows:      ${rows[0]?.count ?? '?'}`,
        `  city radius:        ${CITY_RADIUS_M} m (uniform by area)`,
        `  search radius:      ${SEARCH_RADIUS_M} m`,
        `  iterations:         ${ITERATIONS} (after ${WARMUP} warm-up)`,
        `  last result size:   ${lastSize}`,
        `  p50:                ${p50.toFixed(2)} ms`,
        `  p95:                ${p95.toFixed(2)} ms`,
        `  p99:                ${p99.toFixed(2)} ms`,
        `  max:                ${(sorted[sorted.length - 1] ?? Number.NaN).toFixed(2)} ms`,
        '',
      ].join('\n'),
    );

    // The plan on the same dataset the figures above came from — so the PR
    // does not have to take "it used the index" on trust at this size.
    const plan = await db.execute<{ 'QUERY PLAN': string }>(
      sql`explain (analyze, buffers) ${nearbyMastersQuery({
        serviceId,
        latitude: CITY_CENTRE.latitude,
        longitude: CITY_CENTRE.longitude,
        radiusM: SEARCH_RADIUS_M,
        maxCommissionDebtMinor: 5000,
        maxPositionAgeSeconds: MAX_POSITION_AGE_SECONDS,
        limit: 20,
      })}`,
    );
    process.stdout.write(`${plan.rows.map((row) => row['QUERY PLAN']).join('\n')}\n`);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 600_000);
});
