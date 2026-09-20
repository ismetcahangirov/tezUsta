import { randomUUID } from 'node:crypto';

import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { presenceKey } from '../src/infra/presence/master-presence.service';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { MasterAvailabilityController } from '../src/modules/masters/master-availability.controller';
import {
  CANDIDATE_OVERFETCH_FACTOR,
  NearbyMastersRepository,
  nearbyMastersQuery,
} from '../src/modules/masters/nearby-masters.repository';
import { NearbyMastersService } from '../src/modules/masters/nearby-masters.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * This run's Redis namespace (#125) — parsed through the same schema the
 * application under test uses, so the suite cannot drift from it.
 */
const keyPrefix = parseEnv(process.env).redis.keyPrefix;

/**
 * The nearby-eligible-masters query, end to end against a real PostGIS
 * database and a real Redis (issue #100).
 *
 * **One test per exclusion term, each turning exactly one thing off against an
 * otherwise-eligible master.** A single "happy path plus one big negative"
 * suite would pass with half the predicate deleted: every excluded master
 * would still be excluded, by whichever term happened to survive. The seed
 * helper below therefore builds a master who *is* eligible by default, and
 * each test names the one field it spoils.
 *
 * Why an integration test and not a unit test: every claim here is a claim
 * about Postgres. `ST_DWithin` versus `ST_Distance`, metres versus degrees,
 * "the latest row per master" versus "any row", and whether the GiST index on
 * `(position::geography)` is actually reachable are all properties of the
 * query plan, and a mocked repository asserts nothing about any of them.
 *
 * `PRESENCE_*`, `DISPATCH_MAX_POSITION_AGE_SECONDS` and
 * `DISPATCH_MAX_MASTERS_PER_BROADCAST` are pinned before the app boots —
 * `ConfigModule` reads `process.env` exactly once, at instantiation — so the
 * position-age bound is 120 seconds rather than the default 300, the presence
 * TTL is 30, and the broadcast cap is small enough to seed past.
 *
 * **The presence TTL and the position-age bound are pinned to different
 * numbers on purpose.** They are different windows (ADR-0026), and a suite
 * that set them equal could not tell a test that passes from one that passes
 * for the wrong reason.
 */

/** `users.phone_e164` is unique among live rows — see `master-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

/** The floor `env.schema.ts` allows, so presence expiry is quick to arrange. */
const PRESENCE_TTL_SECONDS = 30;
const PRESENCE_HEARTBEAT_SECONDS = 10;

/**
 * The freshness bound, at the floor `env.schema.ts` allows — deliberately
 * **four times** the presence TTL above, so the two windows cannot be confused
 * for each other by a test that passes for the wrong reason (ADR-0026).
 */
const MAX_POSITION_AGE_SECONDS = 120;

/** Small enough that five eligible masters prove the cap bites. */
const MAX_MASTERS_PER_BROADCAST = 3;

/** The debt ceiling this suite asserts the boundary of, rather than inheriting. */
const MAX_COMMISSION_DEBT_MINOR = 5000;

/** Baku, and the centre of every search below. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

/** The radius every test searches with, unless it is testing the radius itself. */
const RADIUS_M = 3000;

const DEFAULT_PRICE_MINOR = 4500;

interface SeedOptions {
  /** Metres due east of {@link SEARCH_POINT}, geodesically exact via `ST_Project`. */
  readonly distanceM?: number;
  readonly verificationStatus?: 'pending_verification' | 'active' | 'suspended' | 'rejected';
  readonly isAvailable?: boolean;
  readonly commissionDebtMinor?: number;
  readonly offersService?: boolean;
  readonly serviceIsActive?: boolean;
  readonly priceMinor?: number | null;
  /** How long ago the position was recorded. Past the presence TTL it is stale. */
  readonly locationAgeSeconds?: number;
  /** Whether a live heartbeat exists in Redis. */
  readonly live?: boolean;
  readonly deleted?: boolean;
}

describe('the nearby eligible masters query (issue #100)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let db: Database;
  let redis: Redis;
  let presence: MasterPresenceService;
  let nearby: NearbyMastersService;
  let discovery: DiscoveryService;
  /** Every route Fastify registered, captured as it was registered. */
  const registeredRoutes: { readonly method: string; readonly url: string }[] = [];
  let serviceId: string;
  let otherServiceId: string;
  /** Every master this suite seeds, so its Redis cleanup can be its own. */
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  /**
   * One master who is eligible on every term, minus whatever the caller
   * spoils. Written with SQL rather than through the HTTP endpoints on
   * purpose: `POST /masters/me/location` refuses an unverified or offline
   * master, which is precisely the master several of these tests need.
   */
  async function seedMaster(options: SeedOptions = {}): Promise<string> {
    const {
      distanceM = 1000,
      verificationStatus = 'active',
      isAvailable = true,
      commissionDebtMinor = 0,
      offersService = true,
      serviceIsActive = true,
      priceMinor = DEFAULT_PRICE_MINOR,
      locationAgeSeconds = 0,
      live = true,
      deleted = false,
    } = options;

    const userId = randomUUID();
    const masterId = randomUUID();

    await pool.query('insert into users (id, phone_e164) values ($1, $2)', [userId, nextPhone()]);
    await pool.query(
      `insert into masters
         (id, user_id, display_name, verification_status, suspended_at,
          is_available, commission_debt_minor, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        masterId,
        userId,
        'Usta Test',
        verificationStatus,
        verificationStatus === 'suspended' ? new Date() : null,
        isAvailable,
        commissionDebtMinor,
        deleted ? new Date() : null,
      ],
    );

    if (offersService) {
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         values ($1, $2, $3, $4)`,
        [masterId, serviceId, priceMinor, serviceIsActive],
      );
    } else {
      // Offers *a* service, just not this one — so the test distinguishes "no
      // rows at all" from "no row for this service".
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         values ($1, $2, $3, true)`,
        [masterId, otherServiceId, priceMinor],
      );
    }

    await recordPosition(masterId, distanceM, locationAgeSeconds);
    seededMasterIds.push(masterId);
    if (live) {
      await presence.refresh(masterId);
    }
    return masterId;
  }

  /**
   * A position `distanceM` metres due east of the search point, `ageSeconds`
   * ago.
   *
   * `ST_Project` rather than arithmetic on degrees: the whole point of the
   * radius tests is that metres and degrees are not interchangeable, so the
   * fixture may not assume a conversion factor the query is being tested for.
   */
  async function recordPosition(
    masterId: string,
    distanceM: number,
    ageSeconds = 0,
  ): Promise<void> {
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values (
         $1, $2,
         ST_Project(
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
           $5::double precision,
           radians(90)
         )::geometry,
         now() - make_interval(secs => $6::int)
       )`,
      [
        randomUUID(),
        masterId,
        SEARCH_POINT.longitude,
        SEARCH_POINT.latitude,
        distanceM,
        ageSeconds,
      ],
    );
  }

  async function findEligible(radiusM = RADIUS_M) {
    return nearby.findEligible({
      serviceId,
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
      radiusM,
    });
  }

  async function idsOf(radiusM = RADIUS_M): Promise<string[]> {
    return (await findEligible(radiusM)).map((row) => row.masterId);
  }

  async function isEligible(masterId: string, radiusM = RADIUS_M): Promise<boolean> {
    return nearby.isEligible(masterId, {
      serviceId,
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
      radiusM,
    });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', String(PRESENCE_TTL_SECONDS));
    set('PRESENCE_HEARTBEAT_SECONDS', String(PRESENCE_HEARTBEAT_SECONDS));
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', String(MAX_POSITION_AGE_SECONDS));
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', String(MAX_MASTERS_PER_BROADCAST));
    set('MAX_COMMISSION_DEBT_MINOR', String(MAX_COMMISSION_DEBT_MINOR));

    // `DiscoveryModule` is imported alongside the real application so the
    // HTTP-surface test below can enumerate every controller Nest registered,
    // in every module, rather than the ones somebody remembered to list.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    const adapter = new FastifyAdapter();
    // Added BEFORE `app.init()`, which is when Nest registers the routes:
    // `onRoute` fires once per route, so this is the Fastify route table
    // itself rather than a list of what we expected it to contain.
    adapter.getInstance().addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        registeredRoutes.push({ method, url: route.url });
      }
    });
    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    redis = app.get(REDIS_CLIENT);
    presence = app.get(MasterPresenceService);
    nearby = app.get(NearbyMastersService);
    discovery = app.get(DiscoveryService);
    db = app.get<Database>(DATABASE_CONNECTION);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 2`,
    );
    const [first, second] = rows;
    if (first === undefined || second === undefined) {
      throw new Error('The migrated catalogue has fewer than two active services.');
    }
    serviceId = first.id;
    otherServiceId = second.id;
  });

  afterEach(async () => {
    // Every test seeds its own masters and asserts on the whole result set, so
    // the table has to be empty between them. `master_locations` is
    // append-only by trigger, and the retention cutoff is the one hatch:
    // publishing a cutoff in the future makes every row deletable, which is
    // exactly the "an admin console still hits the wall" caveat in
    // `0015_master_locations.sql` — legitimate here, inside one transaction,
    // in a throwaway database.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('tezusta.location_retention', 'infinity', true)`);
      await client.query('delete from master_locations');
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await pool.query('delete from master_services');
    await pool.query('delete from masters');
    await pool.query('delete from user_roles');
    await pool.query('delete from users');
    // Everything this run wrote, by pattern. Safe because presence keys now
    // carry a per-run namespace (`REDIS_KEY_PREFIX`, issue #125): this glob
    // cannot reach `master-availability.e2e` or `master-location.e2e`, which
    // is exactly what the id-by-id deletion this replaced was working around.
    const seeded = await redis.keys(presenceKey(keyPrefix, '*'));
    if (seeded.length > 0) {
      await redis.del(...seeded);
    }
    seededMasterIds.length = 0;
    vi.restoreAllMocks();
  });

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
  });

  describe('an eligible master', () => {
    it('comes back with their distance in metres and their own price', async () => {
      const masterId = await seedMaster({ distanceM: 1200, priceMinor: 6700 });

      const found = await findEligible();

      expect(found).toHaveLength(1);
      expect(found[0]?.masterId).toBe(masterId);
      // Metres, not degrees: 1200 m east of the search point, and a degree of
      // longitude in Baku is ~84 km, so a degree-based answer would be ~0.014.
      expect(found[0]?.distanceM).toBeCloseTo(1200, 0);
      // The accept path freezes THIS number (ADR-0013), so it travels with the
      // candidate rather than being looked up again later.
      expect(found[0]?.priceMinor).toBe(6700);
    });

    it('carries a null price for an inspection-priced offer rather than dropping the master', async () => {
      // `master_services.price_minor` is null for an inspection service, where
      // the amount does not exist until a master has seen the work. That is
      // not an eligibility failure, and a join that quietly required a price
      // would remove those masters from dispatch entirely.
      const masterId = await seedMaster({ priceMinor: null });

      const found = await findEligible();

      expect(found.map((row) => row.masterId)).toEqual([masterId]);
      expect(found[0]?.priceMinor).toBeNull();
    });
  });

  describe('each exclusion term, one at a time', () => {
    it('excludes a master who is not verified', async () => {
      const eligible = await seedMaster();
      await seedMaster({ verificationStatus: 'pending_verification' });

      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a suspended master', async () => {
      const eligible = await seedMaster();
      await seedMaster({ verificationStatus: 'suspended' });

      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a master who is live in Redis but has switched themselves off', async () => {
      // Intent and liveness are different facts, and this is the half Postgres
      // owns: the master toggled availability off, possibly on another device.
      const eligible = await seedMaster();
      const off = await seedMaster({ isAvailable: false, live: true });

      expect(await redis.get(presenceKey(keyPrefix, off))).not.toBeNull();
      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a master who is available in Postgres but not live in Redis', async () => {
      // The other half, and the one Postgres cannot see: a force-quit app
      // leaves `is_available = true` behind forever. Dispatching to it sends
      // an offer nobody will ever read.
      const eligible = await seedMaster();
      const dead = await seedMaster({ isAvailable: true, live: false });

      const { rows } = await pool.query<{ is_available: boolean }>(
        'select is_available from masters where id = $1',
        [dead],
      );
      expect(rows[0]?.is_available).toBe(true);
      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a master who does not offer the service', async () => {
      const eligible = await seedMaster();
      await seedMaster({ offersService: false });

      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a master whose offer for the service is paused', async () => {
      const eligible = await seedMaster();
      await seedMaster({ serviceIsActive: false });

      expect(await idsOf()).toEqual([eligible]);
    });

    it('excludes a master whose commission debt is over the ceiling, and keeps one exactly at it', async () => {
      const atCeiling = await seedMaster({
        distanceM: 900,
        commissionDebtMinor: MAX_COMMISSION_DEBT_MINOR,
      });
      await seedMaster({ distanceM: 1100, commissionDebtMinor: MAX_COMMISSION_DEBT_MINOR + 1 });

      expect(await idsOf()).toEqual([atCeiling]);
    });

    it('excludes a master whose newest position is older than DISPATCH_MAX_POSITION_AGE_SECONDS', async () => {
      // Stale is missing, not "in range": the last position report predates the
      // window in which an online app is required to have sent one, so we do
      // not know where this master is. Nothing here invents a number — the
      // bound is configuration (ADR-0026).
      const eligible = await seedMaster();
      await seedMaster({ locationAgeSeconds: MAX_POSITION_AGE_SECONDS * 2, live: true });

      expect(await idsOf()).toEqual([eligible]);
    });

    it('keeps a live, heartbeating master whose position is older than the presence TTL', async () => {
      // The defect this file was missing. `POST /masters/me/availability/heartbeat`
      // refreshes presence and writes NO position, and the location budget's
      // distance filter means a stationary master sends nothing beyond the
      // floor — so a verified, available master parked 800 m from the customer
      // routinely has a position older than PRESENCE_TTL_SECONDS while being
      // perfectly reachable. Bounding position age by the presence TTL deleted
      // exactly that master from every broadcast, and dispatch answered
      // NO_MASTER_FOUND over somebody four minutes away (ADR-0026).
      const parked = await seedMaster({
        distanceM: 800,
        locationAgeSeconds: PRESENCE_TTL_SECONDS * 2,
        live: true,
      });

      expect(await redis.get(presenceKey(keyPrefix, parked))).not.toBeNull();
      expect(await idsOf()).toEqual([parked]);
    });

    it('excludes a soft-deleted master', async () => {
      const eligible = await seedMaster();
      await seedMaster({ deleted: true });

      expect(await idsOf()).toEqual([eligible]);
    });

    /**
     * `masterEligibilityTerms` is shared by both queries, so `deleted_at is
     * null` has to be asserted on **both** or the shared term is only half
     * covered — and the accept path cannot cover it end to end: a soft-deleted
     * master's profile is already invisible to `MastersService.getOwn`, so
     * `POST /masters/me/offers/:id/accept` answers 404 long before the
     * predicate is consulted. That 404 is the right answer and it is asserted
     * in `master-offers.e2e.test.ts`; this is the assertion that the term
     * itself is still in the `WHERE` clause, which is what would matter the
     * day anything reaches `isEligible` by another path.
     */
    it('answers not-eligible for a soft-deleted master asked about by name', async () => {
      const eligible = await seedMaster();
      const removed = await seedMaster({ deleted: true });

      expect(await isEligible(eligible)).toBe(true);
      expect(await isEligible(removed)).toBe(false);
    });

    it('excludes a master with no position at all', async () => {
      const eligible = await seedMaster();
      const positionless = await seedMaster();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('tezusta.location_retention', 'infinity', true)`);
        await client.query('delete from master_locations where master_id = $1', [positionless]);
        await client.query('commit');
      } finally {
        client.release();
      }

      expect(await idsOf()).toEqual([eligible]);
    });
  });

  describe('the radius', () => {
    it('includes a master just inside it and excludes one just outside', async () => {
      const inside = await seedMaster({ distanceM: RADIUS_M - 50 });
      await seedMaster({ distanceM: RADIUS_M + 50 });

      expect(await idsOf()).toEqual([inside]);
    });

    it('judges a master by their latest position, not by an older one that was in range', async () => {
      // The `LATERAL … ORDER BY recorded_at DESC LIMIT 1` earns its place
      // here: a plain join would see the old in-range row and dispatch to
      // somebody who has since driven out of the city.
      const eligible = await seedMaster({ distanceM: 800 });
      const droveAway = await seedMaster({ distanceM: 500, locationAgeSeconds: 20 });
      await recordPosition(droveAway, RADIUS_M + 2000, 0);

      expect(await idsOf()).toEqual([eligible]);
    });

    it('judges a master by their latest position when the older one was out of range', async () => {
      const arrived = await seedMaster({ distanceM: RADIUS_M + 2000, locationAgeSeconds: 20 });
      await recordPosition(arrived, 700, 0);

      expect(await idsOf()).toEqual([arrived]);
    });

    it('returns each master once however many positions they have reported', async () => {
      const masterId = await seedMaster({ distanceM: 600, locationAgeSeconds: 25 });
      await recordPosition(masterId, 610, 20);
      await recordPosition(masterId, 620, 10);
      await recordPosition(masterId, 630, 0);

      const found = await findEligible();

      expect(found).toHaveLength(1);
      expect(found[0]?.distanceM).toBeCloseTo(630, 0);
    });
  });

  describe('ordering and the broadcast cap', () => {
    it('returns the nearest masters first, capped at the configured broadcast size', async () => {
      const seeded: string[] = [];
      for (const distanceM of [2500, 400, 1600, 800, 2000]) {
        seeded.push(await seedMaster({ distanceM }));
      }
      const [farthest, nearest, third, second, fourth] = seeded;

      const found = await findEligible();

      expect(found.map((row) => row.masterId)).toEqual([nearest, second, third]);
      expect(found).toHaveLength(MAX_MASTERS_PER_BROADCAST);
      expect(found.map((row) => row.distanceM)).toEqual(
        [...found.map((row) => row.distanceM)].sort((a, b) => a - b),
      );
      expect(found.map((row) => row.masterId)).not.toContain(fourth);
      expect(found.map((row) => row.masterId)).not.toContain(farthest);
    });
  });

  describe('the broadcast cap and masters who have gone dark', () => {
    it('does not let dark masters consume cap slots when live masters are behind them', async () => {
      // The `LIMIT` lands in Postgres, before liveness is known. Fetching
      // exactly the cap means the nearest N dark masters eat the whole
      // broadcast — and widening the radius cannot rescue it: the next round
      // returns the same dark ids, still the nearest, plus farther masters
      // that sort after them and are cut by the same `LIMIT`.
      const dark: string[] = [];
      for (const distanceM of [200, 300, 400, 500]) {
        dark.push(await seedMaster({ distanceM, live: false }));
      }
      const live: string[] = [];
      for (const distanceM of [1000, 1100, 1200]) {
        live.push(await seedMaster({ distanceM, live: true }));
      }

      const found = await idsOf();

      expect(dark.length).toBeGreaterThan(MAX_MASTERS_PER_BROADCAST);
      expect(found).toEqual(live);
    });

    it('still returns no more than the broadcast cap when everyone is live', async () => {
      // The other side of the over-fetch: Postgres is asked for
      // `cap * CANDIDATE_OVERFETCH_FACTOR` rows, and the cap is what leaves
      // this method. Seeding past the over-fetch proves the truncation is the
      // service's and not an accident of how many rows came back.
      const seeded: string[] = [];
      for (let i = 0; i < MAX_MASTERS_PER_BROADCAST * CANDIDATE_OVERFETCH_FACTOR + 2; i += 1) {
        seeded.push(await seedMaster({ distanceM: 200 + i * 50 }));
      }

      const found = await idsOf();

      expect(found).toHaveLength(MAX_MASTERS_PER_BROADCAST);
      expect(found).toEqual(seeded.slice(0, MAX_MASTERS_PER_BROADCAST));
    });
  });

  describe('the radius the caller asks for', () => {
    it('clamps a radius above DISPATCH_MAX_RADIUS_M rather than scanning the trail table', async () => {
      // `radiusM` is the one parameter dispatch chooses per round, and an
      // unbounded one turns the GiST prefilter into a scan of every position
      // row in the table. `DISPATCH_MAX_RADIUS_M` (10 km by default) is where
      // dispatch stops widening, so it is also the widest question this query
      // will answer.
      const inside = await seedMaster({ distanceM: 9000 });
      await seedMaster({ distanceM: 11_000 });

      expect(await idsOf(500_000)).toEqual([inside]);
    });

    it('throws on a non-positive radius rather than answering "nobody is nearby"', async () => {
      await seedMaster({ distanceM: 500 });

      await expect(findEligible(0)).rejects.toThrow(RangeError);
      await expect(findEligible(-1)).rejects.toThrow(RangeError);
    });
  });

  describe('when Redis is unreachable', () => {
    it('throws rather than answering "nobody is online" or "everybody is online"', async () => {
      // Both silent answers are wrong in a way nothing downstream can detect:
      // one produces a spurious NO_MASTER_FOUND, the other broadcasts to
      // phones nobody can reach. `MasterPresenceService.filterLive` has no
      // catch, and this asserts that nothing above it added one.
      await seedMaster();
      const outage = new Error('Connection is closed.');
      vi.spyOn(redis, 'mget').mockRejectedValueOnce(outage);

      await expect(findEligible()).rejects.toThrow('Connection is closed.');
    });
  });

  describe('the query plan', () => {
    /**
     * Seeds a city's worth of masters in four set-based statements.
     *
     * The plan assertion below is worthless on ten rows — Postgres would pick
     * a sequential scan on cost alone, and forcing `enable_seqscan = off`
     * proves only that the index *can* be used, not that it is. This seeds
     * enough rows that the planner chooses the index on its own.
     */
    async function seedCity(masterCount: number, positionsEach: number): Promise<void> {
      await pool.query(
        `insert into users (id, phone_e164)
         select gen_random_uuid(), '+9945' || lpad(g::text, 8, '0')
           from generate_series(1, $1) g`,
        [masterCount],
      );
      await pool.query(
        `insert into masters (id, user_id, display_name, verification_status, is_available)
         select gen_random_uuid(), u.id, 'Usta Seed', 'active', true
           from users u
          where u.phone_e164 like '+9945%'`,
      );
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         select m.id, $1, 4500, true from masters m`,
        [serviceId],
      );
      await pool.query(
        `insert into master_locations (id, master_id, position, recorded_at)
         select gen_random_uuid(),
                m.id,
                ST_Project(
                  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                  random() * 40000,
                  random() * 2 * pi()
                )::geometry,
                now() - make_interval(secs => (p - 1) * 5)
           from masters m
           cross join generate_series(1, $3) p`,
        [SEARCH_POINT.longitude, SEARCH_POINT.latitude, positionsEach],
      );
      await pool.query('analyze master_locations');
      await pool.query('analyze masters');
      await pool.query('analyze master_services');
    }

    it('answers ST_DWithin from the GiST index on (position::geography)', async () => {
      await seedCity(5000, 4);

      const plan = await db.execute<{ 'QUERY PLAN': string }>(
        sql`explain (analyze, buffers) ${nearbyMastersQuery({
          serviceId,
          latitude: SEARCH_POINT.latitude,
          longitude: SEARCH_POINT.longitude,
          radiusM: RADIUS_M,
          maxCommissionDebtMinor: MAX_COMMISSION_DEBT_MINOR,
          maxPositionAgeSeconds: MAX_POSITION_AGE_SECONDS,
          limit: MAX_MASTERS_PER_BROADCAST,
        })}`,
      );
      const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');

      // Printed, not merely asserted on: the PR for this issue is required to
      // paste the plan, and a plan nobody can read is a claim rather than
      // evidence.
      process.stdout.write(`\n${planText}\n`);

      // The index is on the CAST, not the bare column (ADR-0018). An index on
      // `position` would produce a Seq Scan here with no warning of any kind.
      expect(planText).toContain('master_locations_position_idx');
      expect(planText).toContain('Bitmap Index Scan');
      expect(planText).not.toContain('Seq Scan on master_locations');
    }, 120_000);
  });

  describe('the HTTP surface', () => {
    /**
     * A "masters near me" route over this query would hand every master's
     * position to whoever asked (CLAUDE.md §11), and until this test that was
     * protected by a comment.
     *
     * Walks the **real** Fastify route table (captured from `onRoute` as Nest
     * registered it) and the **real** controller list (`DiscoveryService`, so a
     * controller in a module nobody remembered still counts), and asserts which
     * controllers can reach `NearbyMastersService` or its repository through
     * any depth of constructor injection.
     *
     * **Issue #100 could say "none". Issue #101 cannot, and the difference is
     * named here rather than hidden by relaxing the assertion.** The accept
     * path re-evaluates this exact predicate at the instant a master claims a
     * job (`docs/product/master-flow.md` § Accepting), so `MasterOffersService`
     * legitimately injects it and `MasterOffersController` legitimately reaches
     * it transitively. The list below is therefore an **allow-list of one**: a
     * second name appearing in it is a new route over the most sensitive query
     * in the schema, and has to be argued for here before it ships.
     *
     * What keeps that one controller safe is not this test — it is that its
     * only use is `isEligible`, a boolean about the **caller themselves**,
     * never a list of masters. That is asserted where it is observable, in
     * `master-offers.e2e.test.ts`: the serialized offer card carries no
     * coordinate and not even a distance in metres.
     */
    const ALLOWED_TO_REACH_NEARBY_MASTERS = ['MasterOffersController'];

    type Constructor = abstract new (...args: never[]) => unknown;

    function isConstructor(value: unknown): value is Constructor {
      return typeof value === 'function';
    }

    /** Whether `target` injects `needle`, at any depth. */
    function injects(
      target: Constructor,
      needle: Constructor,
      seen = new Set<Constructor>(),
    ): boolean {
      if (target === needle) {
        return true;
      }
      if (seen.has(target)) {
        return false;
      }
      seen.add(target);
      const parameters = Reflect.getMetadata('design:paramtypes', target) as unknown;
      if (!Array.isArray(parameters)) {
        return false;
      }
      return parameters.some(
        (parameter: unknown) => isConstructor(parameter) && injects(parameter, needle, seen),
      );
    }

    function controllers(): Constructor[] {
      return discovery
        .getControllers()
        .map((wrapper) => wrapper.metatype as unknown)
        .filter(isConstructor);
    }

    it('sees the transitive dependencies of a controller at all', () => {
      // A positive control. Without it, the assertion below would pass just as
      // happily if `injects` always answered false — which is exactly how a
      // privacy test quietly stops testing anything.
      expect(injects(MasterAvailabilityController, MasterPresenceService)).toBe(true);
      expect(injects(MasterAvailabilityController, NearbyMastersService)).toBe(false);
    });

    it('lets only the sanctioned controller reach NearbyMastersService', () => {
      expect(registeredRoutes.length).toBeGreaterThan(0);

      const exposed = controllers().filter(
        (controller) =>
          injects(controller, NearbyMastersService) || injects(controller, NearbyMastersRepository),
      );

      expect(exposed.map((controller) => controller.name).sort()).toEqual(
        ALLOWED_TO_REACH_NEARBY_MASTERS,
      );
    });

    it('attributes every registered route to a controller that was scanned', () => {
      // Without this, the assertion above would still pass if `DiscoveryService`
      // returned nothing: a route nobody can attribute is a route nobody
      // checked.
      const prefixes = controllers().map((controller) => {
        const declared = Reflect.getMetadata(PATH_METADATA, controller) as unknown;
        return typeof declared === 'string' ? `/${declared.replace(/^\/+/, '')}` : '/';
      });

      const unattributed = registeredRoutes.filter(
        (route) =>
          !prefixes.some((prefix) => route.url === prefix || route.url.startsWith(`${prefix}/`)),
      );

      expect(unattributed).toEqual([]);
    });
  });
});
