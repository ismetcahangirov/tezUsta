// Turned down BEFORE anything imports the config module: `parseEnv` reads
// `process.env` once, when `APP_CONFIG` is first resolved, so a value set in
// `beforeAll` would arrive after the app had already read the shipped 30/180
// second defaults — and this whole suite would take twenty minutes. The
// parameters being configuration rather than literals (ADR-0009) is exactly
// what makes the real engine, against real Redis and real Postgres, testable
// in seconds. There are no fake timers anywhere in this file.
process.env.DISPATCH_INITIAL_RADIUS_M = '1000';
process.env.DISPATCH_MAX_RADIUS_M = '4000';
process.env.DISPATCH_RADIUS_STEP_SECONDS = '1';
process.env.DISPATCH_TOTAL_TIMEOUT_SECONDS = '3';
process.env.DISPATCH_MAX_MASTERS_PER_BROADCAST = '3';
// The floor `env.schema.ts` allows, and deliberately far from the presence
// TTL: they are different windows (ADR-0026) and a suite that set them equal
// could not tell a pass from a pass for the wrong reason.
process.env.DISPATCH_MAX_POSITION_AGE_SECONDS = '120';
process.env.PRESENCE_TTL_SECONDS = '60';
process.env.PRESENCE_HEARTBEAT_SECONDS = '10';
// Every test here creates an order, and the per-user/per-IP budgets are far
// smaller than this file needs.
process.env.ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR = '5000';
process.env.ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR = '5000';

import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  DISPATCH_GIVE_UP_JOB,
  DISPATCH_WAVE_JOB,
} from '../src/modules/dispatch/dispatch.constants';
import { OrderOffersRepository } from '../src/modules/orders/order-offers.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The dispatch engine, end to end (issue #103).
 *
 * **Everything here is real.** Real Postgres with PostGIS, real Redis, the
 * real BullMQ worker running inside the app, the real HTTP route that creates
 * an order. The only thing turned down is the clock, through the configuration
 * ADR-0009 requires these parameters to live in — three waves at t = 0, 1 and
 * 2 seconds, radii 1000 → 2500 → 4000 m, and a give-up deadline at 3 seconds.
 *
 * A mocked queue or a fake timer would assert nothing about the thing this
 * issue is actually about: that an order left alone by every master ends up
 * `NO_MASTER_FOUND` rather than searching forever, that a tick arriving after
 * somebody accepted writes nothing, and that two replicas running the same
 * engine produce one set of offers.
 */

/** The wave plan these settings produce. Derived by hand, asserted below. */
const WAVE_RADII = [1000, 2500, 4000] as const;
const DEADLINE_MS = 3000;

/** Baku. Every order and every master in this file is placed against it. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99452${String(phoneCounter).padStart(7, '0')}`;
}

interface OfferRow {
  readonly master_id: string;
  readonly round: number;
  readonly radius_m: number;
  readonly distance_m: number;
  readonly status: string;
  readonly expires_at: Date;
}

interface HistoryRow {
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly actor_admin_id: string | null;
}

interface LogEntry {
  readonly level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  readonly message: string;
}

/**
 * Every `Logger` call the application makes, with the level it asked for.
 *
 * Installed with `app.useLogger`, which is the seam Nest itself provides:
 * `Logger.overrideLogger` redirects every `new Logger(context)` in the graph,
 * so this sees what the dispatch engine actually asked for rather than what
 * `ConsoleLogger` happened to print. Reading the level from the call is the
 * whole point — "this is not an error" is a statement about the level, and a
 * test that grepped rendered console text for `ERROR` would pass just as
 * happily after a formatting change.
 */
class RecordingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];

  log(message: unknown): void {
    this.record('log', message);
  }
  error(message: unknown): void {
    this.record('error', message);
  }
  warn(message: unknown): void {
    this.record('warn', message);
  }
  debug(message: unknown): void {
    this.record('debug', message);
  }
  verbose(message: unknown): void {
    this.record('verbose', message);
  }
  fatal(message: unknown): void {
    this.record('fatal', message);
  }

  /** Everything recorded since a mark, so one test cannot read another's log. */
  since(index: number): LogEntry[] {
    return this.entries.slice(index);
  }

  private record(level: LogEntry['level'], message: unknown): void {
    this.entries.push({ level, message: String(message) });
  }
}

/**
 * Polls rather than sleeping a fixed amount, for the reason
 * `deferred-work.e2e.test.ts` gives: against a real queue a fixed sleep is
 * either flaky or slow, and usually both.
 */
async function eventually<T>(
  produce: () => Promise<T>,
  satisfied: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (satisfied(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Condition was still false after ${String(timeoutMs)}ms; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the dispatch engine (issue #103)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let redis: Redis;
  let presence: MasterPresenceService;
  let handlers: DeferredJobHandlerRegistry;
  let logs: RecordingLogger;
  let serviceId: string;
  let accessToken: string;
  let addressId: string;
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  /**
   * A master who is eligible on every term — verified, available, offering the
   * service, positioned `distanceM` metres due east of the order, and live in
   * Redis unless the caller says otherwise.
   *
   * Written in SQL rather than through the HTTP endpoints because
   * `POST /masters/me/location` refuses an unverified or offline master, and
   * several tests here need one.
   */
  async function seedMaster(options: { distanceM: number; live?: boolean } = { distanceM: 500 }) {
    const { distanceM, live = true } = options;
    const userId = randomUUID();
    const masterId = randomUUID();

    await pool.query('insert into users (id, phone_e164) values ($1, $2)', [userId, nextPhone()]);
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status, is_available)
       values ($1, $2, 'Usta Test', 'active', true)`,
      [masterId, userId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 4500, true)`,
      [masterId, serviceId],
    );
    // `ST_Project` rather than arithmetic on degrees: the radius assertions
    // below are about metres, so the fixture may not assume a conversion the
    // query itself is being tested for.
    await pool.query(
      `insert into master_locations (id, master_id, position)
       values ($1, $2,
         ST_Project(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5::double precision, radians(90))::geometry
       )`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude, distanceM],
    );

    seededMasterIds.push(masterId);
    if (live) {
      await presence.refresh(masterId);
    }
    return masterId;
  }

  async function createOrder(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        serviceId,
        addressId,
        description: 'Mətbəxdə kran sızır.',
        idempotencyKey: randomUUID(),
      });

    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  async function offersOf(orderId: string): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(
      `select master_id::text as master_id, round, radius_m, distance_m, status, expires_at
         from order_offers where order_id = $1 order by round, master_id`,
      [orderId],
    );
    return rows;
  }

  async function offerFor(orderId: string, masterId: string): Promise<OfferRow | undefined> {
    return (await offersOf(orderId)).find((row) => row.master_id === masterId);
  }

  async function statusOf(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [orderId],
    );
    return rows[0]?.status ?? 'MISSING';
  }

  async function historyOf(orderId: string): Promise<HistoryRow[]> {
    const { rows } = await pool.query<HistoryRow>(
      `select from_status, to_status, actor_kind,
              actor_user_id::text as actor_user_id, actor_admin_id::text as actor_admin_id
         from order_status_history where order_id = $1 order by created_at`,
      [orderId],
    );
    return rows;
  }

  /** The search's generation, as the engine derives it. */
  async function searchingSinceMs(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ ts: Date }>(
      `select date_trunc('milliseconds', max(created_at)) as ts
         from order_status_history where order_id = $1 and to_status = 'SEARCHING'`,
      [orderId],
    );
    const timestamp = rows[0]?.ts;
    if (timestamp === undefined || timestamp === null) {
      throw new Error('The order never entered SEARCHING');
    }
    return timestamp.getTime();
  }

  /**
   * Takes an order out of `SEARCHING` the way another Epic's endpoint would —
   * the status change and its audit row together.
   *
   * These suites seed what they need directly rather than calling #101's
   * accept or EPIC 8's cancel, neither of which exists on this branch. What is
   * being tested is what the engine does when it finds the order in that
   * state, and that is identical however the state arrived.
   */
  async function leaveSearching(
    orderId: string,
    to: 'ACCEPTED' | 'CANCELLED',
    actor: { kind: string; userId?: string | undefined },
    masterId?: string,
  ): Promise<void> {
    await pool.query(
      to === 'ACCEPTED'
        ? `update orders set status = 'ACCEPTED', master_id = $2, price_minor = 4500, accepted_at = now() where id = $1`
        : `update orders set status = 'CANCELLED' where id = $1`,
      to === 'ACCEPTED' ? [orderId, masterId] : [orderId],
    );
    await pool.query(
      `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, actor_user_id)
       values ($1, $2, 'SEARCHING', $3, $4, $5)`,
      [randomUUID(), orderId, to, actor.kind, actor.userId ?? null],
    );
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    // A key space nothing else writes to — the per-IP half of every rate-limit
    // policy is shared by every process talking to this Redis.
    set('RATE_LIMIT_KEY_SECRET', `dispatch-${randomUUID()}`);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    logs = new RecordingLogger();
    // Redirects every `Logger` in the graph, this one and the second app the
    // two-replica test boots, so a level assertion reads the real call.
    app.useLogger(logs);

    redis = app.get(REDIS_CLIENT);
    presence = app.get(MasterPresenceService);
    handlers = app.get(DeferredJobHandlerRegistry);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      'select id from services where is_active order by id limit 1',
    );
    const first = rows[0];
    if (first === undefined) {
      throw new Error('The migrated catalogue has no active service.');
    }
    serviceId = first.id;

    // One customer, signed in, with one saved address at the search point.
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    accessToken = (await app.get(SessionsService).startSession({ userId: created.user.id }))
      .accessToken;

    const profile = await request(app.getHttpServer())
      .post('/customers')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await request(app.getHttpServer())
      .post('/addresses')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        formattedAddress: 'Nizami küçəsi 203',
        latitude: SEARCH_POINT.latitude,
        longitude: SEARCH_POINT.longitude,
      });
    expect(address.status).toBe(201);
    addressId = (address.body as { id: string }).id;
  });

  afterEach(async () => {
    /**
     * Masters are retired rather than deleted: `order_offers` references them
     * with `onDelete: 'restrict'`, and the offers are the evidence each test
     * asserted on. A soft-deleted, unavailable master is invisible to the
     * eligibility query, which is all the next test needs — and it leaves the
     * previous test's rows intact to read if one of them fails.
     */
    await pool.query(
      `update masters set deleted_at = now(), is_available = false where deleted_at is null`,
    );
    if (seededMasterIds.length > 0) {
      // Only this suite's keys. Redis is shared, and a wildcard delete would
      // take out `master-availability.e2e`'s presence mid-test.
      await redis.del(...seededMasterIds.map((id) => `presence:master:${id}`));
      seededMasterIds.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('a search nobody answers', () => {
    it('broadcasts, widens to reach a master who was out of range, then ends in NO_MASTER_FOUND', async () => {
      // Inside the first wave's 1000 m.
      const near = await seedMaster({ distanceM: 400 });
      // Outside it, inside the second wave's 2500 m — the widening is the only
      // thing that can reach this master.
      const far = await seedMaster({ distanceM: 1800 });

      const orderId = await createOrder();

      const firstWave = await eventually(
        () => offerFor(orderId, near),
        (row) => row !== undefined,
      );
      expect(firstWave?.round).toBe(1);
      expect(firstWave?.radius_m).toBe(WAVE_RADII[0]);
      expect(firstWave?.status).toBe('offered');
      // The distance the master was actually shown, not a recomputation.
      expect(firstWave?.distance_m).toBeGreaterThan(380);
      expect(firstWave?.distance_m).toBeLessThan(420);

      // The far master could not have been reached by round 1.
      expect(await offerFor(orderId, far)).toBeUndefined();

      const widened = await eventually(
        () => offerFor(orderId, far),
        (row) => row !== undefined,
      );
      expect(widened?.round).toBe(2);
      expect(widened?.radius_m).toBe(WAVE_RADII[1]);

      const finalStatus = await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );
      expect(finalStatus).toBe('NO_MASTER_FOUND');

      // Never the maximum's ceiling, on any round.
      for (const offer of await offersOf(orderId)) {
        expect(offer.radius_m).toBeLessThanOrEqual(WAVE_RADII[2]);
      }
    }, 30_000);

    it('records the transition as a system act with no actor, not as a cancellation', async () => {
      await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );

      const trail = await historyOf(orderId);
      expect(trail.map((row) => `${row.from_status}->${row.to_status}`)).toEqual([
        'DRAFT->SEARCHING',
        'SEARCHING->NO_MASTER_FOUND',
      ]);

      const terminal = trail.at(-1);
      // `system` names nobody: an unfilled order is a supply signal, and
      // attributing it to a person would corrupt the cancellation rate
      // (ADR-0015).
      expect(terminal?.actor_kind).toBe('system');
      expect(terminal?.actor_user_id).toBeNull();
      expect(terminal?.actor_admin_id).toBeNull();
      expect(await statusOf(orderId)).not.toBe('CANCELLED');
    }, 30_000);

    /**
     * **This is not a sweep, and the distinction matters.** Mid-search, an
     * offer whose window runs out is left exactly as it is — `offered`, with a
     * past `expires_at` that every reader filters on — because a job per offer
     * would be ~120 per order to do what one indexed predicate does.
     *
     * The one moment a row is rewritten is when the search itself ends: one
     * `UPDATE ... WHERE order_id = $1 AND status = 'offered'`, in the same
     * transaction as the terminal transition. A terminal order carrying rows
     * that still say `offered` would be a trail that contradicts the order it
     * belongs to — a feed would hide them and an audit read would not.
     */
    it('closes out its remaining offers in the transaction that ends the search', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );

      // Read in one statement, so this cannot pass on a moment where only one
      // of the two had landed: the terminal status and the closed offer are
      // one transaction, or this is the wrong design.
      const { rows } = await pool.query<{ status: string; offer_status: string }>(
        `select o.status, f.status as offer_status
           from orders o join order_offers f on f.order_id = o.id
          where o.id = $1 and f.master_id = $2`,
        [orderId, master],
      );

      expect(rows[0]).toEqual({ status: 'NO_MASTER_FOUND', offer_status: 'expired' });
    }, 30_000);

    it('tells the customer the truth while it is still searching', async () => {
      await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      const response = await request(app.getHttpServer())
        .get(`/orders/${orderId}`)
        .set('authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      // Searching, not an error — and a null price is legitimate until a
      // master accepts (ADR-0013), never a missing value to hide.
      expect(response.body).toMatchObject({
        status: 'SEARCHING',
        priceMinor: null,
        masterId: null,
      });
    }, 30_000);
  });

  describe('a wave that finds nobody', () => {
    /**
     * **A wave that reaches nobody is ordinary, not an error** — the expected
     * outcome in a thin coverage area at 03:00, and a `NO_MASTER_FOUND` order
     * is a supply signal rather than an incident. Logging it at error level
     * would page somebody for an ordinary Tuesday, and an alert that fires on
     * an ordinary Tuesday is an alert nobody reads.
     *
     * Asserted against the **level the application asked for**, through the
     * `LoggerService` Nest routes every `Logger` call to, rather than by
     * matching `ERROR` in captured console text. The string form would pass
     * just as happily if the colour codes changed.
     */
    it('is logged, and never above log level', async () => {
      // No masters at all: `afterEach` has retired every master the previous
      // test seeded, so the eligibility query genuinely finds nobody.
      const from = logs.entries.length;
      const orderId = await createOrder();

      const entry = await eventually(
        () => Promise.resolve(logs.since(from).find((row) => row.message.includes(orderId))),
        (row) => row?.message.includes('reached nobody') === true,
      );

      // The positive control: something really was recorded, so the negative
      // assertions below are assertions rather than an empty array agreeing.
      expect(entry?.level).toBe('log');
      expect(logs.since(from).filter((row) => row.level === 'error')).toEqual([]);
      expect(logs.since(from).filter((row) => row.level === 'warn')).toEqual([]);

      // And the order still ends properly rather than hanging.
      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );
      expect(await statusOf(orderId)).toBe('NO_MASTER_FOUND');
    }, 30_000);
  });

  describe('a tick that arrives after the race is over', () => {
    it('leaves an accepted order accepted and writes nothing', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );

      // A master accepts mid-search. The remaining schedule is deliberately
      // NOT cancelled here: cancellation is an optimisation, and the guard is
      // what has to make the late tick harmless.
      await leaveSearching(orderId, 'ACCEPTED', { kind: 'system' }, master);
      const offersAtAccept = await offersOf(orderId);

      // Well past the give-up deadline, so every remaining tick has fired.
      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 1500));

      expect(await statusOf(orderId)).toBe('ACCEPTED');
      expect((await historyOf(orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND')).toBe(
        false,
      );
      expect(await offersOf(orderId)).toEqual(offersAtAccept);
    }, 30_000);

    it('leaves a cancelled order cancelled and ends the search', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );

      await leaveSearching(orderId, 'CANCELLED', { kind: 'system' });
      const offersAtCancel = await offersOf(orderId);

      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 1500));

      // `CANCELLED` is where it stays: the give-up tick must not overwrite a
      // customer's cancellation with a supply outcome.
      expect(await statusOf(orderId)).toBe('CANCELLED');
      expect((await historyOf(orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND')).toBe(
        false,
      );
      expect(await offersOf(orderId)).toEqual(offersAtCancel);
    }, 30_000);

    /**
     * The guard the two tests above cannot reach.
     *
     * They prove the engine stops when it *reads* a non-searching order, which
     * is the common case. The race ADR-0009 actually cares about is narrower:
     * a master accepting between the engine's read and its write. That window
     * is microseconds wide and cannot be opened from outside, so the guard is
     * asserted where it lives — one statement that refuses to write when the
     * database says the order is no longer searching, whatever the caller
     * believed a moment earlier.
     */
    it('writes no offer for an order the database says is no longer searching', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );
      const before = await offersOf(orderId);

      await leaveSearching(orderId, 'ACCEPTED', { kind: 'system' }, master);

      const written = await app.get(OrderOffersRepository).broadcast({
        orderId,
        round: 2,
        radiusM: WAVE_RADII[1],
        expiresAt: new Date(Date.now() + 60_000),
        candidates: [{ masterId: await seedMaster({ distanceM: 500 }), distanceM: 500 }],
      });

      expect(written).toEqual([]);
      expect(await offersOf(orderId)).toEqual(before);
    }, 30_000);
  });

  describe('at-least-once delivery', () => {
    it('produces one wave when the same tick is delivered twice', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      const first = await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );

      // The redelivery only says anything while the first offer is still live
      // — a window that has genuinely run out is *meant* to be re-offered.
      // Asserted rather than assumed, so a slow machine fails here with a
      // reason instead of failing below with a puzzle.
      expect(first?.expires_at.getTime()).toBeGreaterThan(Date.now());

      // The redelivery BullMQ's contract permits: the same job, the same
      // payload, handed to the handler a second time.
      const payload = { orderId, searchingSinceMs: await searchingSinceMs(orderId), round: 1 };
      await handlers.resolve(DISPATCH_WAVE_JOB)(payload);

      const offers = await offersOf(orderId);
      expect(offers.filter((row) => row.master_id === master)).toHaveLength(1);
      // Still the round the first delivery wrote: a live offer is not
      // re-offered, so the second delivery changed nothing at all.
      expect(offers[0]?.round).toBe(first?.round);
      expect(offers[0]?.expires_at).toEqual(first?.expires_at);
    }, 30_000);

    it('produces one set of offers when two engine instances run the same round', async () => {
      const masters = [await seedMaster({ distanceM: 300 }), await seedMaster({ distanceM: 400 })];
      const orderId = await createOrder();

      await eventually(
        () => offersOf(orderId),
        (rows) => rows.length === masters.length,
      );

      // A second, independent application graph — its own engine, its own
      // connections, the same Postgres and Redis. This is the two-replica case
      // the conditional guards and the unique index exist for.
      const second = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const secondApp = await second
        .createNestApplication<NestFastifyApplication>(new FastifyAdapter())
        .init();

      try {
        const payload = { orderId, searchingSinceMs: await searchingSinceMs(orderId), round: 2 };
        await Promise.all([
          handlers.resolve(DISPATCH_WAVE_JOB)(payload),
          secondApp.get(DeferredJobHandlerRegistry).resolve(DISPATCH_WAVE_JOB)(payload),
        ]);

        const offers = await offersOf(orderId);
        expect(offers).toHaveLength(masters.length);
        expect(new Set(offers.map((row) => row.master_id))).toEqual(new Set(masters));
      } finally {
        await secondApp.close();
      }
    }, 30_000);
  });

  describe('who a later wave may reach', () => {
    it('never re-offers to a master who declined, and re-offers one whose offer expired', async () => {
      const decliner = await seedMaster({ distanceM: 300 });
      const expirer = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offersOf(orderId),
        (rows) => rows.length === 2,
      );

      // Two different answers to the same offer (ADR-0009): a refusal, and a
      // notification missed while driving.
      await pool.query(
        `update order_offers set status = 'declined', responded_at = now()
          where order_id = $1 and master_id = $2`,
        [orderId, decliner],
      );

      /**
       * **Expiry is a column, not a swept state.** An offer whose window runs
       * out mid-search is not rewritten by anything: the row stays `offered`
       * and simply stops satisfying `expires_at > now()`, which is what every
       * reader filters on. Sweeping it to `expired` would be a job per offer —
       * ~120 per order across six waves — to do what one indexed predicate
       * already does.
       *
       * So the fixture reproduces exactly that shape rather than the tidier
       * one, and asserts it, because the predicate the next wave depends on is
       * the one under test.
       */
      await pool.query(
        `update order_offers set expires_at = now() - interval '1 second'
          where order_id = $1 and master_id = $2`,
        [orderId, expirer],
      );
      const runOut = await offerFor(orderId, expirer);
      expect(runOut?.status).toBe('offered');

      // The run-out offer comes back on the next round, with that round's
      // figures rather than the stale ones.
      const reoffered = await eventually(
        () => offerFor(orderId, expirer),
        (row) => (row?.round ?? 0) > 1,
      );
      expect(reoffered?.status).toBe('offered');
      expect(reoffered?.expires_at.getTime()).toBeGreaterThan(
        runOut?.expires_at.getTime() ?? Number.POSITIVE_INFINITY,
      );

      // ...and the decline is permanent, in this round and every later one.
      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );
      const declined = await offerFor(orderId, decliner);
      expect(declined?.status).toBe('declined');
      expect(declined?.round).toBe(1);
      // And still exactly one row for that pair, ever.
      expect((await offersOf(orderId)).filter((row) => row.master_id === decliner)).toHaveLength(1);
    }, 30_000);

    it('reaches a master who came online between waves', async () => {
      const latecomer = await seedMaster({ distanceM: 400, live: false });
      const orderId = await createOrder();

      // Offline when the first wave ran: eligible in Postgres, dark in Redis.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await offerFor(orderId, latecomer)).toBeUndefined();

      await presence.refresh(latecomer);

      const reached = await eventually(
        () => offerFor(orderId, latecomer),
        (row) => row !== undefined,
      );
      expect(reached?.round).toBeGreaterThan(1);
    }, 30_000);

    it('never broadcasts to more masters than the configured cap', async () => {
      // Five eligible masters, a cap of three.
      for (let index = 0; index < 5; index += 1) {
        await seedMaster({ distanceM: 100 + index * 10 });
      }
      const orderId = await createOrder();

      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );

      expect((await offersOf(orderId)).length).toBeLessThanOrEqual(3);
    }, 30_000);
  });

  describe('a tick left over from an earlier search', () => {
    /**
     * The case EPIC 8's re-dispatch will produce: an order is `SEARCHING`
     * again, on a new clock, while a job from the previous search is still in
     * the queue. The status guard alone would happily match — the order really
     * is searching — so the search's own start time is in the guard too.
     */
    it('cannot give up on the search that replaced it', async () => {
      await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();
      const generation = await searchingSinceMs(orderId);

      await handlers.resolve(DISPATCH_GIVE_UP_JOB)({
        orderId,
        searchingSinceMs: generation - 60_000,
      });

      expect(await statusOf(orderId)).toBe('SEARCHING');
      expect((await historyOf(orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND')).toBe(
        false,
      );

      // And the real deadline still ends it, so the stale tick did not consume
      // the outcome either.
      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );
      expect(await statusOf(orderId)).toBe('NO_MASTER_FOUND');
    }, 30_000);

    it('cannot broadcast a round of the search that replaced it', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();
      const generation = await searchingSinceMs(orderId);

      await handlers.resolve(DISPATCH_WAVE_JOB)({
        orderId,
        searchingSinceMs: generation - 60_000,
        round: 3,
      });

      // Nothing at round 3's radius, because that tick belonged to a search
      // this order is no longer running.
      expect((await offerFor(orderId, master))?.radius_m).not.toBe(WAVE_RADII[2]);
    }, 30_000);
  });
});
