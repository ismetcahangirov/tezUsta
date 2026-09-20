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
import { OrderDispatchRegistry } from '../src/modules/orders/order-dispatch.registry';
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
  /**
   * Null for `offered` and `expired`, set for the three statuses that carry a
   * response — the CHECK on the table makes those two facts the same fact. It
   * is therefore the cleanest evidence that a row was **re-offered**: a `lost`
   * row cannot have a null `responded_at`, so a null one on a master who lost
   * a race can only have been written by a later wave.
   */
  readonly responded_at: Date | null;
}

/**
 * Everything about an offer row **except** who has since answered it: which
 * master it went to, and the round, radius, distance and expiry the wave that
 * wrote it used.
 *
 * These five are written only by a broadcast, so a comparison over them says
 * "no wave touched these rows" without also saying "and nothing else in the
 * system moved while I looked". `status` and `responded_at` are deliberately
 * absent: both belong to somebody answering an offer or to the close-out that
 * ends a search, neither of which a test about the broadcast guard is entitled
 * to freeze (issue #121).
 */
function offerIdentity(rows: readonly OfferRow[]): unknown[] {
  return rows.map(({ master_id, round, radius_m, distance_m, expires_at }) => ({
    master_id,
    round,
    radius_m,
    distance_m,
    expires_at,
  }));
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
  /**
   * A second, independent application graph — its own engine, its own
   * connections, the same Postgres and Redis. Booted here rather than inside
   * the test that needs it: compiling a Nest graph with Postgres, Redis and
   * BullMQ connections takes longer than this suite's whole three-second
   * search window, so a test that booted it mid-search was asserting on rows
   * the real scheduler had written while both handlers returned early.
   */
  let secondApp: NestFastifyApplication;
  let secondHandlers: DeferredJobHandlerRegistry;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let redis: Redis;
  let presence: MasterPresenceService;
  let handlers: DeferredJobHandlerRegistry;
  let logs: RecordingLogger;
  let serviceId: string;
  let accessToken: string;
  /** The signed-in customer, for the fixtures that must act as them. */
  let customerUserId: string;
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

  /** The user a seeded master signs in as — the actor a transition records. */
  async function userIdOfMaster(masterId: string): Promise<string> {
    const { rows } = await pool.query<{ user_id: string }>(
      'select user_id::text as user_id from masters where id = $1',
      [masterId],
    );
    const found = rows[0]?.user_id;
    if (found === undefined) {
      throw new Error('No such master');
    }
    return found;
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
      `select master_id::text as master_id, round, radius_m, distance_m, status,
              expires_at, responded_at
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
    // `order_status_history_actor_shape`: `customer` and `master` name a user,
    // `system` names nobody. Asserted here so a fixture that gets it wrong
    // fails with the rule rather than with a constraint name.
    expect(actor.userId !== undefined).toBe(actor.kind === 'customer' || actor.kind === 'master');
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

  /**
   * EPIC 8's re-dispatch, in the shape `backend-architecture.md` § Re-dispatch
   * specifies it: the assigned master drops the job, `master_id` and
   * `price_minor` are cleared, `redispatch_count` goes up, and the order goes
   * back out on a **new** clock.
   *
   * Written here rather than called, because the edge exists in the transition
   * table and nothing drives it yet. What is under test is that the engine is
   * re-entrant — that a second search reaches masters — and that is identical
   * however the order got back to `SEARCHING`.
   */
  async function redispatch(orderId: string, fromMasterId: string): Promise<void> {
    await pool.query(
      `update orders
          set status = 'SEARCHING', master_id = null, price_minor = null,
              accepted_at = null, redispatch_count = redispatch_count + 1
        where id = $1`,
      [orderId],
    );
    await pool.query(
      `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, actor_user_id)
       values ($1, $2, 'ACCEPTED', 'SEARCHING', 'master', $3)`,
      [randomUUID(), orderId, await userIdOfMaster(fromMasterId)],
    );
    // Exactly how creation announces a search (issue #103): the engine is
    // re-entered through the registry, never through a private helper.
    await app.get(OrderDispatchRegistry).started(orderId);
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
    customerUserId = created.user.id;
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

    // The second replica, up and connected before any order exists.
    const secondModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    secondApp = await secondModule
      .createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      .init();
    secondHandlers = secondApp.get(DeferredJobHandlerRegistry);

    /**
     * **Last, and that is load-bearing.** `Logger` routes through one static
     * override, and `TestingModuleBuilder.compile()` installs its own
     * `TestingLogger` into it — so a recorder installed before the second
     * graph is compiled is silently replaced, and every level assertion below
     * would then be reading an empty array and agreeing with it. Installed
     * after both graphs exist, it sees every `Logger` call either replica
     * makes, which is what makes "this was not an error" a statement about the
     * level the application asked for.
     */
    logs = new RecordingLogger();
    app.useLogger(logs);
  }, 60_000);

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
    await secondApp.close();
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
      await leaveSearching(
        orderId,
        'ACCEPTED',
        { kind: 'master', userId: await userIdOfMaster(master) },
        master,
      );
      const offersAtAccept = await offersOf(orderId);
      expect(offersAtAccept.map((row) => row.status)).toEqual(['offered']);

      // Well past the give-up deadline, so every remaining tick has fired.
      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 1500));

      expect(await statusOf(orderId)).toBe('ACCEPTED');
      expect((await historyOf(orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND')).toBe(
        false,
      );

      // The ticks wrote no offer and moved no master's answer — but the first
      // of them noticed the search was over and closed the row out, which is
      // the thing `expireLiveOffers` exists to do and which must not depend on
      // the search having ended in `NO_MASTER_FOUND`.
      const after = await offersOf(orderId);
      expect(after).toHaveLength(offersAtAccept.length);
      expect(after.map((row) => row.status)).toEqual(['expired']);
      expect(after.map((row) => [row.master_id, row.round, row.radius_m])).toEqual(
        offersAtAccept.map((row) => [row.master_id, row.round, row.radius_m]),
      );
    }, 30_000);

    it('leaves a cancelled order cancelled and ends the search', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );

      // The actor the transition table names for this edge: `SEARCHING ->
      // CANCELLED: ['customer']`. There is no cancel endpoint on this branch,
      // so the row is written directly — but it is written as the customer,
      // because the acceptance criterion is about a customer cancelling and a
      // fixture claiming `system` would be testing an edge nobody has.
      await leaveSearching(orderId, 'CANCELLED', { kind: 'customer', userId: customerUserId });
      const offersAtCancel = await offersOf(orderId);
      expect(offersAtCancel.map((row) => row.status)).toEqual(['offered']);

      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 1500));

      // `CANCELLED` is where it stays: the give-up tick must not overwrite a
      // customer's cancellation with a supply outcome.
      expect(await statusOf(orderId)).toBe('CANCELLED');
      expect((await historyOf(orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND')).toBe(
        false,
      );

      // And the search really ended: a cancelled order does not keep a master's
      // feed showing a live offer on it. Closing out is the engine's, at the
      // next tick, because no cancel path exists here to do it in its own
      // transaction.
      expect((await offersOf(orderId)).map((row) => row.status)).toEqual(['expired']);
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
      const generation = await searchingSinceMs(orderId);

      await leaveSearching(
        orderId,
        'ACCEPTED',
        { kind: 'master', userId: await userIdOfMaster(master) },
        master,
      );

      /**
       * **Read after the accept, and compared without `status`** (issue #121).
       *
       * The real schedule keeps ticking through this test, and both of its
       * remaining ticks are *correct* behaviour that a baseline read before the
       * accept would mistake for damage. While the order is still `SEARCHING`,
       * a wave whose window has just run out is entitled to re-offer this
       * master at the next round's radius and expiry. Once it is `ACCEPTED`,
       * the first tick to notice closes the row out — `offered` becomes
       * `expired`, which is exactly what a sibling test asserts must happen.
       *
       * So the baseline is taken on the far side of the accept, where the five
       * columns below are frozen by the very guard under test, and `status` is
       * left out because it belongs to the close-out rather than to the
       * broadcast. That is the **stronger** reading, not a relaxation: an
       * `expired` row is re-offerable under the conflict predicate
       * (`status in ('expired', 'lost') or ...`), so "round, radius, distance
       * and expiry did not move" is precisely the evidence that the
       * `exists (... status = 'SEARCHING') for share` guard refused the write.
       * Pinning `status` would assert that no scheduled tick ran, which is a
       * claim about the scheduler's timing and not about this guard.
       */
      const before = offerIdentity(await offersOf(orderId));
      const latecomer = await seedMaster({ distanceM: 500 });

      const written = await app.get(OrderOffersRepository).broadcast({
        orderId,
        searchingSince: new Date(generation),
        round: 2,
        radiusM: WAVE_RADII[1],
        expiresAt: new Date(Date.now() + 60_000),
        candidates: [{ masterId: latecomer, distanceM: 500 }],
      });

      expect(written).toEqual([]);
      // Nothing was re-offered...
      expect(offerIdentity(await offersOf(orderId))).toEqual(before);
      // ...and nobody new was offered anything either.
      expect(await offerFor(orderId, latecomer)).toBeUndefined();
    }, 30_000);

    /**
     * **The race itself, opened with a lock rather than with luck.**
     *
     * The test above proves the guard refuses an order the database already
     * says is `ACCEPTED`. It says nothing about the window this PR claimed to
     * close: an accept that commits *after* the wave's statement began. Under
     * `READ COMMITTED` the `EXISTS` subquery is evaluated against the
     * statement snapshot and EvalPlanQual re-checking reaches only the target
     * rows of an `UPDATE`, so an unlocked subquery reads the superseded
     * `SEARCHING` and mints offers on an accepted order. `FOR SHARE` is what
     * makes the claim true, and this holds the window open on purpose: a
     * second connection keeps an uncommitted accept on the order row, so the
     * wave must wait for it rather than read around it.
     */
    it('waits for an accept that is committing under it, and then writes nothing', async () => {
      const master = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );
      const generation = await searchingSinceMs(orderId);
      const latecomer = await seedMaster({ distanceM: 500 });

      const accepting = await pool.connect();
      let settled = false;
      let written: string[];
      try {
        await accepting.query('begin');
        await accepting.query(
          `update orders set status = 'ACCEPTED', master_id = $2, price_minor = 4500,
                  accepted_at = now()
            where id = $1`,
          [orderId, master],
        );

        const broadcast = app
          .get(OrderOffersRepository)
          .broadcast({
            orderId,
            searchingSince: new Date(generation),
            round: 2,
            radiusM: WAVE_RADII[1],
            expiresAt: new Date(Date.now() + 60_000),
            candidates: [{ masterId: latecomer, distanceM: 500 }],
          })
          .then((result) => {
            settled = true;
            return result;
          });

        await new Promise((resolve) => setTimeout(resolve, 400));
        // Still waiting on the share lock. Without it the statement would have
        // finished already, on a snapshot that still said `SEARCHING`.
        expect(settled).toBe(false);

        await accepting.query(
          `insert into order_status_history
             (id, order_id, from_status, to_status, actor_kind, actor_user_id)
           values ($1, $2, 'SEARCHING', 'ACCEPTED', 'master', $3)`,
          [randomUUID(), orderId, await userIdOfMaster(master)],
        );
        await accepting.query('commit');

        written = await broadcast;
      } finally {
        accepting.release();
      }

      // Re-checked against the row the accept committed, not the one the
      // statement started on.
      expect(written).toEqual([]);
      expect(await offerFor(orderId, latecomer)).toBeUndefined();
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

    /**
     * **Two replicas, asserted on the write rather than on the row count.**
     *
     * A row count proves nothing here: the unique index alone satisfies it,
     * and it would pass just as happily if both engines had each written a
     * full round. What distinguishes one write from two is `round` and
     * `expires_at`, so those are what this reads.
     *
     * The wave-1 offers are held open first so the assertion is not racing the
     * real scheduler's later waves — with a live window, a correct engine
     * writes nothing whichever replica gets there, and the round and expiry
     * the first wave wrote survive untouched.
     */
    it('leaves the round untouched when two engine instances run it at once', async () => {
      const masters = [await seedMaster({ distanceM: 300 }), await seedMaster({ distanceM: 400 })];
      const orderId = await createOrder();

      await eventually(
        () => offersOf(orderId),
        (rows) => rows.length === masters.length,
      );
      await pool.query(
        `update order_offers set expires_at = now() + interval '1 hour' where order_id = $1`,
        [orderId],
      );

      const before = await offersOf(orderId);
      expect(before.map((row) => row.round)).toEqual(masters.map(() => 1));

      const payload = { orderId, searchingSinceMs: await searchingSinceMs(orderId), round: 2 };
      await Promise.all([
        handlers.resolve(DISPATCH_WAVE_JOB)(payload),
        secondHandlers.resolve(DISPATCH_WAVE_JOB)(payload),
      ]);

      // Same rows, same round, same expiry: one write, and it was wave 1's.
      expect(await offersOf(orderId)).toEqual(before);
      expect(new Set(before.map((row) => row.master_id))).toEqual(new Set(masters));
    }, 30_000);

    /**
     * And when there really is a write to make, exactly one of them makes it.
     *
     * The offers are pushed past their window first, so both replicas are
     * entitled to re-offer and the conflict predicate has to decide. Each
     * engine's own repository is called with a **distinguishable** expiry, so
     * the answer is not inferred from the final row — `broadcast` reports who
     * it actually reached, and exactly one of the two may report anybody.
     */
    it('lets exactly one of two engine instances re-offer a run-out round', async () => {
      const masters = [await seedMaster({ distanceM: 300 }), await seedMaster({ distanceM: 400 })];
      const orderId = await createOrder();

      await eventually(
        () => offersOf(orderId),
        (rows) => rows.length === masters.length,
      );
      await pool.query(
        `update order_offers set expires_at = now() - interval '1 second' where order_id = $1`,
        [orderId],
      );

      const searchingSince = new Date(await searchingSinceMs(orderId));
      const candidates = masters.map((masterId) => ({ masterId, distanceM: 400 }));
      const round = (radiusM: number, expiresAt: Date) => ({
        orderId,
        searchingSince,
        round: 2,
        radiusM,
        expiresAt,
        candidates,
      });
      const mine = new Date(Date.now() + 60_000);
      const theirs = new Date(Date.now() + 120_000);

      const [here, there] = await Promise.all([
        app.get(OrderOffersRepository).broadcast(round(WAVE_RADII[1], mine)),
        secondApp.get(OrderOffersRepository).broadcast(round(WAVE_RADII[2], theirs)),
      ]);

      const reached = [here, there];
      expect(reached.filter((result) => result.length > 0)).toHaveLength(1);
      const winner = here.length > 0 ? { radiusM: WAVE_RADII[1] } : { radiusM: WAVE_RADII[2] };

      const offers = await offersOf(orderId);
      expect(offers).toHaveLength(masters.length);
      expect(new Set(offers.map((row) => row.radius_m))).toEqual(new Set([winner.radiusM]));
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

      // `toBe`, not `toBeLessThanOrEqual`: three is the cap and five were
      // eligible, so anything under three is the engine failing to broadcast
      // rather than the cap working.
      expect((await offersOf(orderId)).length).toBe(3);
    }, 30_000);
  });

  describe('a second search on the same order (EPIC 8 re-dispatch)', () => {
    /**
     * **Re-entrancy has to reach somebody, or it is not re-entrancy.**
     *
     * The `ACCEPTED -> SEARCHING` edge is already in the transition table and
     * this engine is the thing a re-dispatch re-enters. The first search
     * leaves every master it reached with an answer on their row: one
     * `accepted`, the rest `lost` the moment somebody won (#101), and whoever
     * refused, `declined`. So the conflict predicate on the wave's upsert is
     * what decides who a *second* search can reach at all — and with `lost`
     * left off it, the answer was nobody: every row was untouchable, the waves
     * wrote nothing, and the order walked to `NO_MASTER_FOUND` having
     * broadcast to an empty set.
     *
     * A master who lost a tap did nothing wrong. A master who declined did,
     * and ADR-0009 makes that permanent — "in any later wave or after a
     * re-dispatch" (issue #103). Both are asserted here, in one order, because
     * the same predicate decides both.
     */
    it('reaches the masters who lost the first race, and never the one who declined', async () => {
      const winner = await seedMaster({ distanceM: 200 });
      const loser = await seedMaster({ distanceM: 300 });
      const decliner = await seedMaster({ distanceM: 400 });
      const orderId = await createOrder();

      await eventually(
        () => offersOf(orderId),
        (rows) => rows.length === 3,
      );

      // Exactly the rows #101's accept leaves behind.
      await pool.query(
        `update order_offers set status = 'declined', responded_at = now()
          where order_id = $1 and master_id = $2`,
        [orderId, decliner],
      );
      await leaveSearching(
        orderId,
        'ACCEPTED',
        { kind: 'master', userId: await userIdOfMaster(winner) },
        winner,
      );
      await pool.query(
        `update order_offers set status = 'accepted', responded_at = now()
          where order_id = $1 and master_id = $2`,
        [orderId, winner],
      );
      await pool.query(
        `update order_offers set status = 'lost', responded_at = now()
          where order_id = $1 and master_id = $2`,
        [orderId, loser],
      );
      const lost = await offerFor(orderId, loser);
      expect(lost?.status).toBe('lost');

      await redispatch(orderId, winner);

      /**
       * `responded_at` is the evidence, not the status: the CHECK on the table
       * makes a `lost` row's response time non-null, so a null one on this
       * master can only have been written by a later wave re-offering them.
       * Read that way, the assertion survives the second search ending while
       * it is being made.
       */
      const again = await eventually(
        () => offerFor(orderId, loser),
        (row) => row !== undefined && row.responded_at === null,
        10_000,
      );
      expect(again?.status).not.toBe('lost');
      expect(again?.expires_at.getTime()).toBeGreaterThan(
        lost?.expires_at.getTime() ?? Number.POSITIVE_INFINITY,
      );

      // Let the second search finish, so "never re-offered" is a claim about
      // all of it rather than about its first round.
      await eventually(
        () => statusOf(orderId),
        (status) => status !== 'SEARCHING',
      );

      // The decline is untouched, and so is the master the re-dispatch took
      // the job away from — `backend-architecture.md` § Re-dispatch requires
      // exactly that they be excluded from the next broadcast.
      const refused = await offerFor(orderId, decliner);
      expect(refused?.status).toBe('declined');
      expect(refused?.responded_at).not.toBeNull();
      const abandoned = await offerFor(orderId, winner);
      expect(abandoned?.status).toBe('accepted');

      // And still one row per pair, across both searches.
      expect(await offersOf(orderId)).toHaveLength(3);
    }, 40_000);
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

      // Wave 1 first, and held open past every later wave, so what follows is
      // an assertion about a row that exists rather than one that passes
      // vacuously because no offer has landed yet.
      const first = await eventually(
        () => offerFor(orderId, master),
        (row) => row !== undefined,
      );
      await pool.query(
        `update order_offers set expires_at = now() + interval '1 hour' where order_id = $1`,
        [orderId],
      );
      const before = await offersOf(orderId);

      await handlers.resolve(DISPATCH_WAVE_JOB)({
        orderId,
        searchingSinceMs: generation - 60_000,
        round: 3,
      });

      // Untouched: that tick belonged to a search this order is no longer
      // running, so it wrote neither round 3's radius nor anything else.
      expect(await offersOf(orderId)).toEqual(before);
      expect(before[0]?.round).toBe(first?.round);
      expect(before[0]?.radius_m).toBe(WAVE_RADII[0]);
    }, 30_000);
  });
});
