import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import { runSeed } from '../src/infra/database/seed';
import {
  collectArrivalMetrics,
  CURRENT_SECONDS_PER_METRE,
} from '../src/modules/arrival-promise/arrival-metrics';
import { formatArrivalMetrics } from '../src/modules/arrival-promise/arrival-metrics.format';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The arrival report against a real Postgres, on seeded orders whose accept,
 * promise and arrival times are known to the second (issue #410), so every
 * count and percentile can be checked by hand.
 */

const BASE_URL = process.env.DATABASE_URL ?? '';

const WINDOW = {
  from: new Date('2026-11-02T00:00:00.000Z'),
  to: new Date('2026-11-03T00:00:00.000Z'),
};
const T0 = new Date('2026-11-02T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

interface OrderSpec {
  /** Seconds after T0. */
  readonly acceptedAt: number;
  readonly promisedAt?: number;
  readonly source?: 'route' | 'estimate';
  readonly arrivedAt?: number;
  readonly distanceM: number;
  /** An earlier master's arrival before a re-dispatch, seconds after T0. */
  readonly earlierArrivalAt?: number;
}

describe('collectArrivalMetrics (issue #410)', () => {
  let throwaway: ThrowawayDatabase;
  let pool: Pool;
  let db: Database;
  let customerId: string;
  let addressId: string;
  let serviceId: string;
  let masterCount = 0;

  async function newMaster(): Promise<string> {
    masterCount += 1;
    const userId = randomUUID();
    const masterId = randomUUID();
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `master-${String(masterCount)}@example.com`,
    ]);
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status)
       values ($1, $2, 'Usta', 'active')`,
      [masterId, userId],
    );
    return masterId;
  }

  async function history(orderId: string, to: string, seconds: number): Promise<void> {
    await pool.query(
      `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
       values ($1, $2, 'SEARCHING', $3, 'system', $4)`,
      [randomUUID(), orderId, to, at(seconds)],
    );
  }

  /**
   * One order's current assignment. An arrived one is left `COMPLETED`, which
   * keeps its master but not `orders_one_active_per_master`'s slot, as a real
   * finished job does.
   */
  async function seed(spec: OrderSpec): Promise<void> {
    const orderId = randomUUID();
    const masterId = await newMaster();
    const arrived = spec.arrivedAt !== undefined;

    await pool.query(
      `insert into orders (id, customer_id, address_id, service_id, status, description,
                           idempotency_key, master_id, price_minor, accepted_at,
                           promised_arrival_at, arrival_promise_source)
       values ($1, $2, $3, $4, $5, 'arrival fixture', $6, $7, 6700, $8, $9, $10)`,
      [
        orderId,
        customerId,
        addressId,
        serviceId,
        arrived ? 'COMPLETED' : 'ACCEPTED',
        randomUUID(),
        masterId,
        at(spec.acceptedAt),
        spec.promisedAt === undefined ? null : at(spec.promisedAt),
        spec.source ?? null,
      ],
    );
    await pool.query(
      `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m,
                                 status, expires_at, responded_at)
       values ($1, $2, $3, 1, 3000, $4, 'accepted', $5, $5)`,
      [randomUUID(), orderId, masterId, spec.distanceM, at(spec.acceptedAt)],
    );
    if (spec.earlierArrivalAt !== undefined) {
      await history(orderId, 'MASTER_ARRIVED', spec.earlierArrivalAt);
    }
    await history(orderId, 'ACCEPTED', spec.acceptedAt);
    if (spec.arrivedAt !== undefined) {
      await history(orderId, 'MASTER_ARRIVED', spec.arrivedAt);
    }
  }

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase(BASE_URL);
    await runMigrations(throwaway.url);
    await runSeed(throwaway.url);
    pool = new Pool({ connectionString: throwaway.url });
    db = drizzle(pool, { schema });

    const userId = randomUUID();
    customerId = randomUUID();
    addressId = randomUUID();
    await pool.query(`insert into users (id, email) values ($1, 'customer@example.com')`, [userId]);
    await pool.query(
      `insert into customers (id, user_id, display_name) values ($1, $2, 'Fixture')`,
      [customerId, userId],
    );
    await pool.query(
      `insert into addresses (id, customer_id, formatted_address, position)
       values ($1, $2, 'Baku', ST_SetSRID(ST_MakePoint(49.842717, 40.372613), 4326))`,
      [addressId, customerId],
    );
    const service = await pool.query<{ id: string }>('select id from services limit 1');
    serviceId = service.rows[0]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await throwaway.drop();
  });

  it('reads an empty window as "no data", never as zeros', async () => {
    const report = await collectArrivalMetrics(db, WINDOW);

    expect(report.accepts).toBe(0);
    expect(report.overall.onTimeShare).toBeNull();
    expect(report.overall.lateBySeconds).toMatchObject({ count: 0, p50: null });
    expect(report.calibration).toMatchObject({
      trips: 0,
      currentCoverage: null,
      speedKmhCovering75: null,
    });
    expect(formatArrivalMetrics(report)).toContain('WARNING: only 0 arrived trips');
  });

  it('counts, measures and calibrates the current assignment of each order', async () => {
    // A: a route promise kept 30 s early; 3 km in 600 s.
    await seed({
      acceptedAt: 0,
      promisedAt: 630,
      source: 'route',
      arrivedAt: 600,
      distanceM: 3_000,
    });
    // B: a route promise missed by 60 s; 2 km in 690 s.
    await seed({
      acceptedAt: 0,
      promisedAt: 630,
      source: 'route',
      arrivedAt: 690,
      distanceM: 2_000,
    });
    // C: an estimate missed by 114 s; 3 km in 900 s.
    await seed({
      acceptedAt: 0,
      promisedAt: 786,
      source: 'estimate',
      arrivedAt: 900,
      distanceM: 3_000,
    });
    // D: arrived with no promise ever written; 1 km in 400 s.
    await seed({ acceptedAt: 0, arrivedAt: 400, distanceM: 1_000 });
    // E: promised, not yet arrived.
    await seed({ acceptedAt: 0, promisedAt: 630, source: 'route', distanceM: 2_500 });
    // F: a short trip, kept 30 s early, too short for the calibration.
    await seed({ acceptedAt: 0, promisedAt: 130, source: 'route', arrivedAt: 100, distanceM: 300 });
    // G: re-dispatched. The earlier master arrived; the current one has not.
    await seed({
      acceptedAt: 1_000,
      promisedAt: 1_600,
      source: 'route',
      earlierArrivalAt: 200,
      distanceM: 2_000,
    });
    // H: accepted the day before, outside the window.
    await seed({
      acceptedAt: -86_400,
      promisedAt: -85_800,
      source: 'route',
      arrivedAt: -85_900,
      distanceM: 2_000,
    });

    const report = await collectArrivalMetrics(db, WINDOW);

    expect(report).toMatchObject({
      accepts: 7,
      promised: 6,
      promisedByRoute: 5,
      promisedByEstimate: 1,
      arrived: 5,
    });
    expect(report.overall).toMatchObject({ measured: 4, onTime: 2, onTimeShare: 0.5 });
    // −30, −30, 60, 114.
    expect(report.overall.lateBySeconds.p50).toBeCloseTo(15, 6);
    expect(report.overall.lateBySeconds.max).toBe(114);
    expect(report.route).toMatchObject({ measured: 3, onTime: 2 });
    expect(report.estimate).toMatchObject({ measured: 1, onTime: 0 });

    // A 0.2, C 0.3, B 0.345, D 0.4 s per metre; F is under 500 m.
    expect(report.calibration.trips).toBe(4);
    expect(report.calibration.secondsPerMetre.p50).toBeCloseTo(0.3225, 6);
    expect(report.calibration.currentSecondsPerMetre).toBeCloseTo(CURRENT_SECONDS_PER_METRE, 9);
    expect(report.calibration.currentCoverage).toBe(0.25);
    // p75 = 0.35875 s/m and p90 = 0.3835 s/m, at the 1.4 detour.
    expect(report.calibration.speedKmhCovering75).toBeCloseTo((1.4 / 0.35875) * 3.6, 6);
    expect(report.calibration.speedKmhCovering90).toBeCloseTo((1.4 / 0.3835) * 3.6, 6);

    const text = formatArrivalMetrics(report);
    expect(text).toContain('accepts            7');
    expect(text).toContain('current covers     25.0% of these trips');
  });
});
