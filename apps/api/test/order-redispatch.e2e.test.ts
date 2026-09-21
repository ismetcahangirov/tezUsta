import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Order } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { DISPATCH_QUEUE } from '../src/infra/queue/queue.constants';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  DISPATCH_GIVE_UP_JOB,
  dispatchGiveUpJobId,
  dispatchWaveJobId,
} from '../src/modules/dispatch/dispatch.constants';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Re-dispatch over real HTTP, against the real dispatch engine (issue #136,
 * EPIC 8): the assigned master cannot come, so the order goes back out.
 *
 * **The live engine is the point of this suite.** `order-transitions.e2e` and
 * `order-cancellation.e2e` configure dispatch to reach nobody, because what
 * they assert is a transaction. Here the acceptance criterion is that the
 * order *genuinely searches again* — a different master is offered it and can
 * accept it — and nothing but a real broadcast against real Postgres and real
 * Redis can show that. The dispatch parameters are turned right down, the way
 * `dispatch.e2e.test.ts` turns them down and for the same reason: ADR-0009
 * made them configuration rather than literals, which is exactly what makes
 * the engine testable in seconds.
 *
 * `MAX_ORDER_REDISPATCHES` is turned down with them, to **one**. The cap is a
 * tuning parameter like the rest, and a suite that had to drive three accepts
 * to reach it would be testing patience rather than the rule.
 *
 * Two things that look like they belong here and do not. The stale-tick guard
 * — a wave from the search that was replaced — is `dispatch.e2e.test.ts`'s,
 * which asserts both halves against a hand-driven generation; what this suite
 * adds is that a *real* re-dispatch produces the new generation that guard
 * needs. And cancellation penalties are out of scope everywhere: who pays for
 * a dropped job is the open owner-owned decision in CLAUDE.md §1.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';
const REASON = 'Maşınım xarab oldu, gələ bilmirəm.';

/** The cap this suite runs under — `MAX_ORDER_REDISPATCHES`, turned down. */
const MAX_REDISPATCHES = 1;

/** Every status the table lets the assigned master send an order back out from. */
const REDISPATCHABLE_FROM = ['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED'] as const;

type RedispatchableFrom = (typeof REDISPATCHABLE_FROM)[number];

/** How the assigned master walks an accepted order to each of those statuses. */
const ADVANCE_PATH = ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED'] as const;

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly priceMinor: number;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customerToken: string;
  readonly customerUserId: string;
}

interface HistoryRow {
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly actor_admin_id: string | null;
  readonly reason: string | null;
}

interface OfferRow {
  readonly id: string;
  readonly master_id: string;
  readonly status: string;
  readonly responded_at: Date | null;
}

interface OrderRowShape {
  readonly status: string;
  readonly master_id: string | null;
  readonly price_minor: string | null;
  readonly accepted_at: Date | null;
  readonly redispatch_count: number;
}

/**
 * Polls rather than sleeping a fixed amount, for the reason
 * `dispatch.e2e.test.ts` gives: against a real queue a fixed sleep is either
 * flaky or slow, and usually both.
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

describe('sending an order back out (issue #136)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let handlers: DeferredJobHandlerRegistry;
  let serviceId: string;

  /**
   * Every master this test seeded, so the next one can retire them.
   *
   * **Without this the suite poisons itself.** Masters accumulate across
   * tests, they all stand at the same distance, and a broadcast reaches only
   * the nearest `DISPATCH_MAX_MASTERS_PER_BROADCAST` of them — so by the
   * seventh test the fresh master a test is waiting on is not in the round at
   * all, and the failure looks like a broken engine rather than a fixture
   * that outstayed its welcome. Retiring them keeps each test's eligible pool
   * to the masters that test created.
   */
  const seededMasterIds: string[] = [];

  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  /** A master eligible on every term the accept path re-checks. */
  async function seedMaster(
    options: { distanceM?: number; priceMinor?: number } = {},
  ): Promise<SeededMaster> {
    const { distanceM = 400, priceMinor = 6700 } = options;
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters
          set verification_status = 'active', is_available = true, commission_debt_minor = 0
        where id = $1`,
      [masterId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, $3, true)`,
      [masterId, serviceId, priceMinor],
    );
    // `ST_Project` rather than arithmetic on degrees: the radius the engine
    // broadcasts at is in metres, so the fixture may not assume a conversion.
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values (
         $1, $2,
         ST_Project(
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
           $5::double precision,
           radians(90)
         )::geometry,
         now()
       )`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude, distanceM],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, userId: caller.userId, accessToken: caller.accessToken, priceMinor };
  }

  /** A real customer, a real address at the job site, and a real `SEARCHING` order. */
  async function seedOrder(): Promise<SeededOrder> {
    const caller = await signIn();
    const profile = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);

    const order = await post('/orders', caller.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    return {
      orderId: (order.body as { id: string }).id,
      customerToken: caller.accessToken,
      customerUserId: caller.userId,
    };
  }

  /** The offer this search made to one master, once the engine has made it. */
  async function offerFor(orderId: string, masterId: string): Promise<OfferRow | undefined> {
    const { rows } = await pool.query<OfferRow>(
      `select id::text as id, master_id::text as master_id, status, responded_at
         from order_offers where order_id = $1 and master_id = $2`,
      [orderId, masterId],
    );
    return rows[0];
  }

  async function offersOf(orderId: string): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(
      `select id::text as id, master_id::text as master_id, status, responded_at
         from order_offers where order_id = $1 order by created_at`,
      [orderId],
    );
    return rows;
  }

  /** Waits for the engine's broadcast to reach `master`, then accepts it. */
  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offer = await eventually(
      () => offerFor(orderId, master.masterId),
      (row) => row !== undefined && row.status === 'offered',
    );
    if (offer === undefined) {
      throw new Error('unreachable: the poll above only returns a defined row');
    }

    const accepted = await post(`/masters/me/offers/${offer.id}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
  }

  /** An order the engine really broadcast, really accepted, and walked to `from`. */
  async function orderIn(from: RedispatchableFrom, master: SeededMaster): Promise<SeededOrder> {
    const order = await seedOrder();
    await accept(order.orderId, master);

    if (from !== 'ACCEPTED') {
      for (const to of ADVANCE_PATH) {
        const advanced = await post(
          `/orders/${order.orderId}/transitions`,
          master.accessToken,
        ).send({ to });
        expect(advanced.status).toBe(200);
        if (to === from) {
          break;
        }
      }
    }

    expect((await orderRow(order.orderId)).status).toBe(from);
    return order;
  }

  /**
   * `reason: null` means "send no reason at all", which is not the same as
   * leaving the argument off — a default parameter fires on `undefined`.
   */
  function redispatch(orderId: string, token?: string, reason: string | null = REASON) {
    return post(`/orders/${orderId}/transitions`, token).send(
      reason === null ? { to: 'SEARCHING' } : { to: 'SEARCHING', reason },
    );
  }

  async function orderRow(orderId: string): Promise<OrderRowShape> {
    const { rows } = await pool.query<OrderRowShape>(
      `select status, master_id::text as master_id, price_minor::text as price_minor,
              accepted_at, redispatch_count
         from orders where id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('No such order');
    }
    return row;
  }

  async function history(orderId: string): Promise<HistoryRow[]> {
    const { rows } = await pool.query<HistoryRow>(
      `select from_status, to_status, actor_kind,
              actor_user_id::text as actor_user_id, actor_admin_id::text as actor_admin_id, reason
         from order_status_history
        where order_id = $1
        order by created_at, id`,
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

  /** Which of one search's jobs are still waiting to run. */
  async function pendingScheduleOf(orderId: string, generation: number): Promise<string[]> {
    const queue = app.get<Queue>(getQueueToken(DISPATCH_QUEUE));
    const planned = [
      dispatchWaveJobId(orderId, generation, 1),
      dispatchGiveUpJobId(orderId, generation),
    ];

    const pending: string[] = [];
    for (const jobId of planned) {
      const job = await queue.getJob(jobId);
      if (job !== undefined && !(await job.isCompleted()) && !(await job.isFailed())) {
        pending.push(jobId);
      }
    }
    return pending;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '60');
    set('PRESENCE_HEARTBEAT_SECONDS', '10');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '120');

    // Budgets are somebody else's subject; here they are only an obstacle.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');

    /**
     * A real engine, on a clock a test can outlive: four waves two seconds
     * apart, widening from 1 km to 4 km, and a deadline at eight seconds. Every
     * seeded master stands 400 m away, so wave 1 reaches all of them — the
     * widening is not what is under test here — and eight seconds is long
     * enough that an assertion made straight after a re-dispatch is not racing
     * the new search's own give-up.
     */
    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '8');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', String(MAX_REDISPATCHES));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    handlers = app.get(DeferredJobHandlerRegistry);

    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  beforeEach(async () => {
    if (seededMasterIds.length === 0) {
      return;
    }
    // `is_available` rather than presence: it is the term of the dispatch
    // predicate a fixture can turn off from SQL, and it is the honest one —
    // a master from a finished test is exactly a master who has gone offline.
    await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
      seededMasterIds,
    ]);
    seededMasterIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    await database.drop();

    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('from every status the table permits', () => {
    it.each(REDISPATCHABLE_FROM)(
      'sends an order back out from %s',
      async (from) => {
        const master = await seedMaster();
        const order = await orderIn(from, master);

        const response = await redispatch(order.orderId, master.accessToken);

        expect(response.status).toBe(200);
        expect((response.body as Order).status).toBe('SEARCHING');

        const row = await orderRow(order.orderId);
        expect(row.status).toBe('SEARCHING');
        // All three, because all three are load-bearing: `master_id` is what the
        // accept guard matches on, `price_minor` belonged to the master who is
        // not coming (ADR-0013), and `accepted_at` would violate
        // `orders_accepted_at_requires_master` if it outlived the master.
        expect(row.master_id).toBeNull();
        expect(row.price_minor).toBeNull();
        expect(row.accepted_at).toBeNull();
        expect(row.redispatch_count).toBe(1);
      },
      40_000,
    );

    it('records it as the assigned master’s act, with the reason they gave', async () => {
      const master = await seedMaster();
      const order = await orderIn('MASTER_ON_THE_WAY', master);

      expect((await redispatch(order.orderId, master.accessToken)).status).toBe(200);

      const row = (await history(order.orderId)).at(-1);
      expect(row?.from_status).toBe('MASTER_ON_THE_WAY');
      expect(row?.to_status).toBe('SEARCHING');
      expect(row?.actor_kind).toBe('master');
      expect(row?.actor_user_id).toBe(master.userId);
      expect(row?.actor_admin_id).toBeNull();
      expect(row?.reason).toBe(REASON);
    }, 40_000);

    it('starts a search on a new clock, with a schedule of its own', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);
      const first = await searchingSinceMs(order.orderId);

      expect((await redispatch(order.orderId, master.accessToken)).status).toBe(200);

      const second = await searchingSinceMs(order.orderId);
      expect(second).toBeGreaterThan(first);
      // The generation is what the job ids are derived from, so a new one is
      // what stops the second search colliding with ids the first already used
      // and being silently dropped (`dispatch.constants.ts`).
      expect(await pendingScheduleOf(order.orderId, second)).toContain(
        dispatchGiveUpJobId(order.orderId, second),
      );
    }, 40_000);
  });

  describe('the second search', () => {
    it('reaches a different master, who can take the job', async () => {
      const dropper = await seedMaster({ priceMinor: 6700 });
      const taker = await seedMaster({ priceMinor: 5200 });
      const order = await orderIn('ACCEPTED', dropper);

      expect((await redispatch(order.orderId, dropper.accessToken)).status).toBe(200);

      await accept(order.orderId, taker);

      const row = await orderRow(order.orderId);
      expect(row.status).toBe('ACCEPTED');
      expect(row.master_id).toBe(taker.masterId);
      // The new master's own price, frozen at their accept — not the price the
      // first master set and not a stale copy of it (ADR-0013).
      expect(row.price_minor).toBe(String(taker.priceMinor));
      expect(row.redispatch_count).toBe(1);
    }, 40_000);

    it('never offers it to the master who dropped it', async () => {
      const dropper = await seedMaster();
      const taker = await seedMaster();
      const order = await orderIn('ACCEPTED', dropper);

      const dropped = await offerFor(order.orderId, dropper.masterId);
      expect(dropped?.status).toBe('accepted');

      expect((await redispatch(order.orderId, dropper.accessToken)).status).toBe(200);

      // The other master's `lost` row is re-offered, which is what makes the
      // second search reach anybody at all — and it is the signal that the
      // broadcast this assertion is about has actually happened.
      await eventually(
        () => offerFor(order.orderId, taker.masterId),
        (row) => row !== undefined && row.status === 'offered' && row.responded_at === null,
      );

      // Untouched, through the whole of the second search: the upsert never
      // reaches an `accepted` row, which is the whole of the exclusion
      // (`backend-architecture.md` § Re-dispatch).
      await eventually(
        () => orderRow(order.orderId),
        (row) => row.status !== 'SEARCHING',
      );
      expect(await offerFor(order.orderId, dropper.masterId)).toEqual(dropped);
    }, 40_000);

    it('cannot be given up on by a tick from the search it replaced', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);
      const replaced = await searchingSinceMs(order.orderId);

      expect((await redispatch(order.orderId, master.accessToken)).status).toBe(200);

      await handlers.resolve(DISPATCH_GIVE_UP_JOB)({
        orderId: order.orderId,
        searchingSinceMs: replaced,
      });

      // The status guard alone would match — the order really is searching —
      // so the generation is in the guard too. `dispatch.e2e.test.ts` asserts
      // both halves of that against a hand-driven generation; what this adds
      // is that a real re-dispatch produces a generation it can tell apart.
      expect((await orderRow(order.orderId)).status).toBe('SEARCHING');
      expect(
        (await history(order.orderId)).some((row) => row.to_status === 'NO_MASTER_FOUND'),
      ).toBe(false);
    }, 40_000);
  });

  describe('the cap', () => {
    it('ends the order in NO_MASTER_FOUND rather than searching a third time', async () => {
      const first = await seedMaster();
      const second = await seedMaster();
      const order = await orderIn('ACCEPTED', first);

      // One re-dispatch is all `MAX_ORDER_REDISPATCHES` allows here.
      expect((await redispatch(order.orderId, first.accessToken)).status).toBe(200);
      await accept(order.orderId, second);

      const response = await redispatch(order.orderId, second.accessToken);

      expect(response.status).toBe(200);
      expect((response.body as Order).status).toBe('NO_MASTER_FOUND');

      const row = await orderRow(order.orderId);
      expect(row.status).toBe('NO_MASTER_FOUND');
      expect(row.master_id).toBeNull();
      expect(row.price_minor).toBeNull();
      expect(row.redispatch_count).toBe(MAX_REDISPATCHES + 1);
    }, 40_000);

    it('walks two real edges rather than inventing one the table lacks', async () => {
      const first = await seedMaster();
      const second = await seedMaster();
      const order = await orderIn('ACCEPTED', first);

      expect((await redispatch(order.orderId, first.accessToken)).status).toBe(200);
      await accept(order.orderId, second);
      expect((await redispatch(order.orderId, second.accessToken)).status).toBe(200);

      // `ACCEPTED -> NO_MASTER_FOUND` is not an edge in ADR-0015's table, and
      // no code path may write one. What the cap does instead is finish the
      // re-dispatch the master drove and end the search it started, in one
      // transaction — two rows, each a real edge with its real actor.
      const trail = await history(order.orderId);
      expect(trail.slice(-2).map((row) => `${row.from_status}->${row.to_status}`)).toEqual([
        'ACCEPTED->SEARCHING',
        'SEARCHING->NO_MASTER_FOUND',
      ]);
      expect(trail.at(-2)?.actor_kind).toBe('master');
      expect(trail.at(-2)?.actor_user_id).toBe(second.userId);
      // Running out of re-dispatches is a supply fact, so the terminal row
      // names nobody — it is not a cancellation by the master (ADR-0015).
      expect(trail.at(-1)?.actor_kind).toBe('system');
      expect(trail.at(-1)?.actor_user_id).toBeNull();
    }, 40_000);

    it('schedules no new search when it terminates the order', async () => {
      const first = await seedMaster();
      const second = await seedMaster();
      const order = await orderIn('ACCEPTED', first);

      expect((await redispatch(order.orderId, first.accessToken)).status).toBe(200);
      await accept(order.orderId, second);
      expect((await redispatch(order.orderId, second.accessToken)).status).toBe(200);

      expect(await pendingScheduleOf(order.orderId, await searchingSinceMs(order.orderId))).toEqual(
        [],
      );
      // And the offers the order still owned are closed, so a terminal order
      // and a live offer on it are never both readable.
      expect((await offersOf(order.orderId)).every((row) => row.status !== 'offered')).toBe(true);
    }, 40_000);
  });

  describe('who may not send it back out', () => {
    it('refuses the customer — their route is cancellation', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      const response = await redispatch(order.orderId, order.customerToken);

      expect(response.status).toBe(403);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_TRANSITION_NOT_PERMITTED');
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 40_000);

    it('refuses a master the order was not assigned to', async () => {
      const master = await seedMaster();
      const stranger = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      const response = await redispatch(order.orderId, stranger.accessToken);

      // 404, never 403: a 403 would make this route a way to ask whether a
      // given id is somebody's job.
      expect(response.status).toBe(404);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 40_000);

    it('refuses an unauthenticated caller', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      expect((await redispatch(order.orderId)).status).toBe(401);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 40_000);
  });

  describe('what the table and the boundary refuse', () => {
    it('refuses a re-dispatch out of IN_PROGRESS', async () => {
      const master = await seedMaster();
      const order = await orderIn('MASTER_ARRIVED', master);

      const started = await post(`/orders/${order.orderId}/transitions`, master.accessToken).send({
        to: 'IN_PROGRESS',
      });
      expect(started.status).toBe(200);

      const response = await redispatch(order.orderId, master.accessToken);

      // ADR-0015 leaves this edge out deliberately: once work has started, a
      // different master cannot pick the job up from an unknown state.
      expect(response.status).toBe(409);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect((await orderRow(order.orderId)).status).toBe('IN_PROGRESS');
    }, 40_000);

    it('refuses a re-dispatch with no reason', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      const response = await redispatch(order.orderId, master.accessToken, null);

      expect(response.status).toBe(422);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 40_000);

    it('refuses a blank reason, which is the same as none', async () => {
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      const response = await redispatch(order.orderId, master.accessToken, '   ');

      expect(response.status).toBe(422);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 40_000);
  });

  describe('two taps at once', () => {
    it('produces one transition, one increment and one new search', async () => {
      // A read-then-write cap check passes every sequential test above and
      // fails here: both requests read a count under the cap, both pass it,
      // and the order is re-dispatched twice on one master's say-so.
      const master = await seedMaster();
      const order = await orderIn('ACCEPTED', master);

      const [first, second] = await Promise.all([
        redispatch(order.orderId, master.accessToken),
        redispatch(order.orderId, master.accessToken),
      ]);

      /**
       * The loser is refused, and **either refusal is honest**. It gets a 409
       * when it read the order before the winner committed — the conditional
       * `UPDATE` matches nothing — and a 404 when it read the order
       * afterwards, because by then `master_id` is null and this master is no
       * longer a party to the order at all. Which one it is depends on
       * microseconds; that it is not a 200 is the invariant.
       */
      const codes = [first.status, second.status].sort((a, b) => a - b);
      expect(codes[0]).toBe(200);
      expect([404, 409]).toContain(codes[1]);

      const row = await orderRow(order.orderId);
      expect(row.status).toBe('SEARCHING');
      expect(row.redispatch_count).toBe(1);
      expect(
        (await history(order.orderId)).filter(
          (entry) => entry.from_status === 'ACCEPTED' && entry.to_status === 'SEARCHING',
        ),
      ).toHaveLength(1);
    }, 40_000);
  });
});
