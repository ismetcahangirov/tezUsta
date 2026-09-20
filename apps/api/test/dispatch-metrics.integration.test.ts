import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../src/infra/database/schema';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { DispatchMetricsReport } from '../src/modules/dispatch/dispatch-metrics';
import { collectDispatchMetrics } from '../src/modules/dispatch/dispatch-metrics';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The dispatch measurement query, against a real database (issue #114).
 *
 * **Seeding fixtures here is not the thing #114 forbids.** The issue refuses
 * to *derive parameter values* from invented traffic, because those numbers
 * would be claims about Baku's supply that nothing observed. What is asserted
 * below is a different kind of claim entirely: that given rows whose meaning
 * is known, the query reports what those rows say. That is a claim about SQL,
 * and rows written on purpose are the only way to check it. No number produced
 * here goes anywhere near ADR-0009.
 *
 * **Integration rather than unit, because every claim is a claim about
 * Postgres.** Whether a search is correctly delimited by the transition that
 * follows it is a claim about `lead()` over a partition; whether an empty
 * window yields `null` rather than `0` is a claim about `percentile_cont`
 * ignoring nulls and about what the `pg` driver hands back for
 * `double precision`. A mocked executor asserts nothing about either, and
 * those two are exactly where a report would go quietly wrong.
 *
 * No Nest app is built: the query takes a Drizzle handle and nothing else, so
 * the suite needs Postgres and not the application.
 */

const BASE_URL = process.env.DATABASE_URL ?? '';

/**
 * Each test gets its own **day**, and reports only on it.
 *
 * The obvious alternative — truncating between tests — is not available, and
 * for a good reason: `order_status_history` refuses `DELETE` outright (the
 * trail is append-only; `database-architecture.md` § Integrity rules). Which
 * leaves isolating by window, and that is the better fixture anyway: it is
 * how the report will be used in production, where the tables are never
 * empty, and a query that only passed against a freshly emptied database
 * would be asserting nothing about that.
 */
let day = 0;

/** Midnight UTC of this test's day, and midnight of the next — half-open. */
function windowOfDay(index: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(2026, 9, index)),
    to: new Date(Date.UTC(2026, 9, index + 1)),
  };
}

/** 09:00 on this test's day. Every scenario is written relative to it. */
function t0(): Date {
  return new Date(windowOfDay(day).from.getTime() + 9 * 60 * 60 * 1000);
}

function at(secondsAfterT0: number): Date {
  return new Date(t0().getTime() + secondsAfterT0 * 1000);
}

type OfferStatus = 'offered' | 'declined' | 'expired' | 'accepted' | 'lost';

interface OfferSpec {
  readonly round: number;
  readonly radiusM: number;
  readonly distanceM: number;
  readonly status: OfferStatus;
  /** When the wave wrote it. */
  readonly createdAt: Date;
  /** Required by the table's own check for declined/accepted/lost. */
  readonly respondedAt?: Date;
}

interface SearchSpec {
  readonly startedAt: Date;
  /** Omit for a search still running when the report is taken. */
  readonly endedAt?: Date;
  readonly endedStatus?: 'ACCEPTED' | 'NO_MASTER_FOUND' | 'CANCELLED' | 'DRAFT';
  readonly offers?: readonly OfferSpec[];
}

describe('collectDispatchMetrics', () => {
  let throwaway: ThrowawayDatabase;
  let pool: Pool;
  let db: Database;
  let customerId: string;
  let addressId: string;
  let serviceId: string;
  /** Reused across orders; `order_offers` is unique per (order, master). */
  let masterIds: string[];

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase(BASE_URL);
    await runMigrations(throwaway.url);
    await runSeed(throwaway.url);

    pool = new Pool({ connectionString: throwaway.url });
    db = drizzle(pool, { schema });

    const userId = randomUUID();
    customerId = randomUUID();
    addressId = randomUUID();

    await pool.query(`insert into users (id, phone_e164) values ($1, $2)`, [
      userId,
      `+99450${String(Date.now()).slice(-7)}`,
    ]);
    await pool.query(
      `insert into customers (id, user_id, display_name) values ($1, $2, 'Measurement fixture')`,
      [customerId, userId],
    );
    await pool.query(
      `insert into addresses (id, customer_id, formatted_address, position)
       values ($1, $2, 'Baku', ST_SetSRID(ST_MakePoint(49.842717, 40.372613), 4326))`,
      [addressId, customerId],
    );

    const service = await pool.query<{ id: string }>('select id from services limit 1');
    const found = service.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    masterIds = [];
    for (let index = 0; index < 8; index += 1) {
      const masterUserId = randomUUID();
      const masterId = randomUUID();
      await pool.query(`insert into users (id, phone_e164) values ($1, $2)`, [
        masterUserId,
        `+99451${String(index).padStart(7, '0')}`,
      ]);
      await pool.query(
        `insert into masters (id, user_id, display_name, verification_status)
         values ($1, $2, $3, 'active')`,
        [masterId, masterUserId, `Master ${String(index)}`],
      );
      masterIds.push(masterId);
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await throwaway.drop();
  });

  beforeEach(() => {
    day += 1;
  });

  /**
   * Writes one order and the searches it went through, straight into the
   * tables — no engine, no queue, no clock to wait out.
   *
   * A search is a `SEARCHING` row in the trail plus the transition that ends
   * it, which is exactly what the query reads, so the fixture is written in
   * the same terms as the thing under test rather than in terms of an API that
   * would have to be driven in real time to produce them.
   */
  async function seedOrder(searches: readonly SearchSpec[]): Promise<string> {
    const orderId = randomUUID();

    await pool.query(
      `insert into orders (id, customer_id, address_id, service_id, status, description,
                           idempotency_key, created_at)
       values ($1, $2, $3, $4, 'SEARCHING', 'measurement fixture', $5, $6)`,
      [orderId, customerId, addressId, serviceId, randomUUID(), searches[0]?.startedAt ?? t0()],
    );

    // Advances across searches, not within one: `order_offers` is unique per
    // (order, master), so a re-dispatch re-offering to master 0 would collide.
    let masterIndex = 0;

    for (const search of searches) {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
         values ($1, $2, 'DRAFT', 'SEARCHING', 'system', $3)`,
        [randomUUID(), orderId, search.startedAt],
      );

      if (search.endedAt !== undefined && search.endedStatus !== undefined) {
        await pool.query(
          `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
           values ($1, $2, 'SEARCHING', $3, 'system', $4)`,
          [randomUUID(), orderId, search.endedStatus, search.endedAt],
        );
      }

      for (const offer of search.offers ?? []) {
        const masterId = masterIds[masterIndex % masterIds.length];
        masterIndex += 1;

        await pool.query(
          `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m,
                                     status, expires_at, responded_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            orderId,
            masterId,
            offer.round,
            offer.radiusM,
            offer.distanceM,
            offer.status,
            new Date(offer.createdAt.getTime() + 30_000),
            offer.respondedAt ?? null,
            offer.createdAt,
          ],
        );
      }
    }

    return orderId;
  }

  function report(
    window: { from: Date; to: Date } = windowOfDay(day),
  ): Promise<DispatchMetricsReport> {
    return collectDispatchMetrics(db, window);
  }

  it('reports an empty window as absent rather than as zero', async () => {
    const { searches, rounds, offers } = await report();

    expect(searches.searches).toBe(0);
    expect(searches.noMasterFoundRate).toBeNull();
    expect(offers.expiryRate).toBeNull();
    expect(rounds).toEqual([]);

    // The load-bearing one: a percentile over no rows must come back null, so
    // the report can say "no data" instead of printing a confident 0.
    expect(searches.timeToAcceptSeconds).toEqual({
      count: 0,
      mean: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      max: null,
    });
  });

  it('measures how long an accept took, from the trail', async () => {
    await seedOrder([{ startedAt: at(0), endedAt: at(47), endedStatus: 'ACCEPTED' }]);
    await seedOrder([{ startedAt: at(100), endedAt: at(113), endedStatus: 'ACCEPTED' }]);

    const { searches } = await report();

    expect(searches.accepted).toBe(2);
    expect(searches.timeToAcceptSeconds.count).toBe(2);
    expect(searches.timeToAcceptSeconds.max).toBe(47);
    expect(searches.timeToAcceptSeconds.p50).toBe(30);
  });

  it('keeps cancelled and unfinished searches out of the no-master-found rate', async () => {
    await seedOrder([{ startedAt: at(0), endedAt: at(20), endedStatus: 'ACCEPTED' }]);
    await seedOrder([{ startedAt: at(0), endedAt: at(180), endedStatus: 'NO_MASTER_FOUND' }]);
    await seedOrder([{ startedAt: at(0), endedAt: at(9), endedStatus: 'CANCELLED' }]);
    await seedOrder([{ startedAt: at(0) }]);

    const { searches } = await report();

    expect(searches.searches).toBe(4);
    expect(searches.cancelled).toBe(1);
    expect(searches.stillOpen).toBe(1);

    // One of the two searches that actually ran out of masters. A denominator
    // including the cancelled and the open one would read 25% and would be
    // measuring customer patience rather than supply.
    expect(searches.noMasterFoundRate).toBe(0.5);
  });

  it('counts a re-dispatch as its own search, with its own offers', async () => {
    // ADR-0015 allows an order to search twice. The second search is not a
    // continuation: its rounds start again at 1 and its outcome is its own.
    await seedOrder([
      {
        startedAt: at(0),
        endedAt: at(180),
        endedStatus: 'NO_MASTER_FOUND',
        offers: [{ round: 1, radiusM: 3000, distanceM: 900, status: 'expired', createdAt: at(0) }],
      },
      {
        startedAt: at(300),
        endedAt: at(340),
        endedStatus: 'ACCEPTED',
        offers: [
          {
            round: 1,
            radiusM: 3000,
            distanceM: 1200,
            status: 'accepted',
            createdAt: at(300),
            respondedAt: at(340),
          },
        ],
      },
    ]);

    const { searches, offers } = await report();

    expect(searches.searches).toBe(2);
    expect(searches.accepted).toBe(1);
    expect(searches.noMasterFound).toBe(1);

    // Each offer landed inside exactly one search's interval — neither was
    // double-counted across the two, and neither was dropped between them.
    expect(offers.offers).toBe(2);
    expect(searches.offersPerSearch.count).toBe(2);
    expect(searches.offersPerSearch.max).toBe(1);

    // The accept came from the second search, so its latency is 40s, not 340s.
    expect(searches.timeToAcceptSeconds.max).toBe(40);
  });

  it('attributes a search to the window it started in, not the one it ended in', async () => {
    const today = windowOfDay(day);
    const justBefore = new Date(today.from.getTime() - 60_000);

    await seedOrder([{ startedAt: justBefore, endedAt: at(30), endedStatus: 'ACCEPTED' }]);
    await seedOrder([
      {
        startedAt: today.from,
        endedAt: new Date(today.from.getTime() + 10_000),
        endedStatus: 'ACCEPTED',
      },
    ]);
    await seedOrder([
      {
        startedAt: today.to,
        endedAt: new Date(today.to.getTime() + 20_000),
        endedStatus: 'ACCEPTED',
      },
    ]);

    const { searches } = await report();

    // Half-open: `from` is inside, `to` is not, and a search that spilled into
    // the window from before it belongs to the earlier report.
    expect(searches.searches).toBe(1);
    expect(searches.timeToAcceptSeconds.max).toBe(10);
  });

  it('reports what each round reached and what it won', async () => {
    // Two orders searching at once, so a round's reach is counted per search
    // rather than per order — one order reaching round 2 does not make the
    // other's round 1 disappear.
    await seedOrder([
      {
        startedAt: at(0),
        endedAt: at(65),
        endedStatus: 'ACCEPTED',
        offers: [
          { round: 1, radiusM: 3000, distanceM: 800, status: 'expired', createdAt: at(0) },
          { round: 1, radiusM: 3000, distanceM: 2400, status: 'expired', createdAt: at(0) },
          {
            round: 2,
            radiusM: 4400,
            distanceM: 4100,
            status: 'accepted',
            createdAt: at(30),
            respondedAt: at(65),
          },
        ],
      },
    ]);
    await seedOrder([
      {
        startedAt: at(0),
        endedAt: at(180),
        endedStatus: 'NO_MASTER_FOUND',
        offers: [{ round: 1, radiusM: 3000, distanceM: 1500, status: 'expired', createdAt: at(0) }],
      },
    ]);

    const { rounds, searches } = await report();

    expect(rounds).toHaveLength(2);

    const [first, second] = rounds;
    expect(first?.round).toBe(1);
    expect(first?.searchesReached).toBe(2);
    expect(first?.offersSent).toBe(3);
    expect(first?.acceptsWon).toBe(0);
    expect(first?.radiusM.p50).toBe(3000);
    // Two offers in one search, one in the other.
    expect(first?.mastersPerBroadcast.max).toBe(2);

    expect(second?.round).toBe(2);
    expect(second?.searchesReached).toBe(1);
    expect(second?.acceptsWon).toBe(1);
    expect(second?.radiusM.p50).toBe(4400);

    // The accepting master's own numbers, not the round's ceiling.
    expect(searches.acceptRound.max).toBe(2);
    expect(searches.acceptRadiusM.max).toBe(4400);
    expect(searches.acceptDistanceM.max).toBe(4100);
  });

  it('keeps pre-empted offers out of the expiry rate', async () => {
    await seedOrder([
      {
        startedAt: at(0),
        endedAt: at(40),
        endedStatus: 'ACCEPTED',
        offers: [
          {
            round: 1,
            radiusM: 3000,
            distanceM: 500,
            status: 'accepted',
            createdAt: at(0),
            respondedAt: at(40),
          },
          {
            round: 1,
            radiusM: 3000,
            distanceM: 900,
            status: 'declined',
            createdAt: at(0),
            respondedAt: at(12),
          },
          { round: 1, radiusM: 3000, distanceM: 1100, status: 'expired', createdAt: at(0) },
          {
            // Taken off the table when somebody else accepted — this master
            // was never given a full window, so counting them as indifferent
            // would overstate the expiry rate.
            round: 1,
            radiusM: 3000,
            distanceM: 1400,
            status: 'lost',
            createdAt: at(0),
            respondedAt: at(40),
          },
          { round: 1, radiusM: 3000, distanceM: 1600, status: 'offered', createdAt: at(0) },
        ],
      },
    ]);

    const { offers } = await report();

    expect(offers.offers).toBe(5);
    expect(offers.lost).toBe(1);
    expect(offers.outstanding).toBe(1);

    // One expired out of accepted + declined + expired.
    expect(offers.expiryRate).toBeCloseTo(1 / 3, 10);
    expect(offers.declineRate).toBeCloseTo(1 / 3, 10);
  });

  it('measures response time only where a master actually responded', async () => {
    await seedOrder([
      {
        startedAt: at(0),
        endedAt: at(20),
        endedStatus: 'ACCEPTED',
        offers: [
          {
            round: 1,
            radiusM: 3000,
            distanceM: 500,
            status: 'accepted',
            createdAt: at(0),
            respondedAt: at(20),
          },
          {
            round: 1,
            radiusM: 3000,
            distanceM: 700,
            status: 'declined',
            createdAt: at(0),
            respondedAt: at(4),
          },
          { round: 1, radiusM: 3000, distanceM: 900, status: 'expired', createdAt: at(0) },
          {
            round: 1,
            radiusM: 3000,
            distanceM: 1100,
            status: 'lost',
            createdAt: at(0),
            respondedAt: at(20),
          },
        ],
      },
    ]);

    const { offers } = await report();

    // Two observations — the accept and the decline. `lost` carries a
    // `responded_at` too, but it is somebody else's clock, and `expired`
    // carries none at all.
    expect(offers.timeToRespondSeconds.count).toBe(2);
    expect(offers.timeToRespondSeconds.max).toBe(20);
    expect(offers.timeToRespondSeconds.p50).toBe(12);

    // Distance is measured over every offer, responded to or not.
    expect(offers.distanceM.count).toBe(4);
  });

  it('ignores offers written outside the search they would otherwise fall in', async () => {
    // An offer written after the search ended belongs to no search. The engine
    // cannot write one — the broadcast guard re-checks the status under a lock
    // — so this is a claim about the attribution rule holding anyway.
    const orderId = await seedOrder([
      { startedAt: at(0), endedAt: at(60), endedStatus: 'NO_MASTER_FOUND' },
    ]);

    await pool.query(
      `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m,
                                 status, expires_at, created_at)
       values ($1, $2, $3, 1, 3000, 800, 'offered', $4, $5)`,
      [randomUUID(), orderId, masterIds[0], at(700), at(600)],
    );

    const { offers, searches } = await report();

    expect(offers.offers).toBe(0);
    expect(searches.offersPerSearch.max).toBe(0);
  });
});
