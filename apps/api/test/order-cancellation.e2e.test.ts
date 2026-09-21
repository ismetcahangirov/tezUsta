import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Order } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  DISPATCH_WAVE_JOB,
  dispatchGiveUpJobId,
  dispatchWaveJobId,
} from '../src/modules/dispatch/dispatch.constants';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * A customer cancelling their own order over real HTTP (issue #135, EPIC 8).
 *
 * **The status column is the least of it.** A cancellation that only wrote
 * `CANCELLED` would leave the order's live offers on a master's feed, leave
 * the search's remaining ticks free to walk it to `NO_MASTER_FOUND`, and leave
 * no record of who ended it or why — and `order_status_history` is append-only,
 * so the missing record could never be filled in afterwards. Every assertion
 * below is about one of those four things rather than about the column.
 *
 * **What is deliberately not here: penalties.** Who may cancel without charge,
 * at which status, and what the charge is, is the open owner-owned decision
 * recorded in CLAUDE.md §1 and restated at the end of ADR-0015 — *"this ADR
 * settles only which transitions exist, not what they cost"*. This suite
 * asserts that cancelling works and is recorded; it asserts nothing about
 * money, because nothing charges anybody.
 *
 * `DRAFT -> CANCELLED` is in the transition table and is **not** tested here,
 * because it cannot be reached: `DRAFT` is the idempotency anchor of an
 * in-flight creation, `OrdersRepository.findById` excludes it, and no HTTP
 * surface has ever shown one. `order-lifecycle.test.ts` transcribes the edge
 * from the ADR; there is nothing this layer could add.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const MASTER_PRICE_MINOR = 6700;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';
const REASON = 'Özüm düzəltdim, usta lazım deyil.';

/**
 * Every status a customer may cancel from that an HTTP client can actually
 * reach, in the order an order walks through them.
 */
const CANCELLABLE_FROM = [
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
] as const;

type CancellableFrom = (typeof CANCELLABLE_FROM)[number];

/** How the assigned master walks an order to each of those statuses. */
const ADVANCE_PATH = ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'] as const;

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly addressId: string;
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
}

describe('a customer cancelling their own order (issue #135)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let handlers: DeferredJobHandlerRegistry;
  let serviceId: string;

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
  async function seedMaster(): Promise<SeededMaster> {
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
      [masterId, serviceId, MASTER_PRICE_MINOR],
    );
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
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude, DEFAULT_DISTANCE_M],
    );
    await presence.refresh(masterId);

    return { masterId, userId: caller.userId, accessToken: caller.accessToken };
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
    const addressId = (address.body as { id: string }).id;

    const order = await post('/orders', caller.accessToken).send({
      serviceId,
      addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    return {
      orderId: (order.body as { id: string }).id,
      addressId,
      customerToken: caller.accessToken,
      customerUserId: caller.userId,
    };
  }

  /** One live offer on an order, as a broadcast round would have written it. */
  async function offerTo(orderId: string, master: SeededMaster): Promise<string> {
    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );
    return offerId;
  }

  /**
   * An order sitting in `from`, reached through the **real** accept and
   * transition paths rather than by writing the status.
   *
   * A hand-written row would also skip the history rows every assertion here
   * counts against, and would leave `master_id` and the offer in states no
   * real order ever holds.
   */
  async function orderIn(
    from: CancellableFrom,
    master: SeededMaster,
  ): Promise<{ order: SeededOrder; offerId: string }> {
    const order = await seedOrder();
    const offerId = await offerTo(order.orderId, master);

    if (from === 'SEARCHING') {
      return { order, offerId };
    }

    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);

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

    expect(await statusOf(order.orderId)).toBe(from);
    return { order, offerId };
  }

  /**
   * `reason: null` means "send no reason at all", which is not the same as
   * leaving the argument off — a default parameter fires on `undefined`, so
   * `undefined` would quietly send the usual reason and the test asserting a
   * 422 would be asserting nothing.
   */
  function cancel(orderId: string, token?: string, reason: string | null = REASON) {
    return post(`/orders/${orderId}/transitions`, token).send(
      reason === null ? { to: 'CANCELLED' } : { to: 'CANCELLED', reason },
    );
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

  async function statusOf(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [orderId],
    );
    return rows[0]?.status ?? 'MISSING';
  }

  async function offersOf(orderId: string): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(
      `select id::text as id, master_id::text as master_id, status
         from order_offers where order_id = $1 order by created_at`,
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

  /** Which of this search's jobs are still waiting to run. */
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
    set('PRESENCE_TTL_SECONDS', '30');
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
     * The live engine is configured to reach nobody, the way
     * `order-transitions.e2e.test.ts` does it and for the same reason: this
     * suite writes its own `order_offers` row per order, and a broadcast into
     * the same table would collide on `order_offers_order_master_unique`. A
     * one-metre initial radius with a single wave reaches none of the masters
     * seeded 1200 m away, and the give-up tick is an hour out, so no schedule
     * fires inside a test's lifetime unless a test drives it by hand — which
     * is exactly what the schedule assertions below do.
     */
    set('DISPATCH_INITIAL_RADIUS_M', '1');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');

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
    it.each(CANCELLABLE_FROM)(
      'cancels an order sitting in %s',
      async (from) => {
        const master = await seedMaster();
        const { order } = await orderIn(from, master);

        const response = await cancel(order.orderId, order.customerToken);

        expect(response.status).toBe(200);
        expect((response.body as Order).status).toBe('CANCELLED');
        expect(await statusOf(order.orderId)).toBe('CANCELLED');
      },
      30_000,
    );

    it('writes exactly one trail row, attributed to the customer, carrying the reason', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('ACCEPTED', master);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);

      const cancellations = (await history(order.orderId)).filter(
        (row) => row.to_status === 'CANCELLED',
      );

      expect(cancellations).toHaveLength(1);
      expect(cancellations[0]?.from_status).toBe('ACCEPTED');
      expect(cancellations[0]?.actor_kind).toBe('customer');
      expect(cancellations[0]?.actor_user_id).toBe(order.customerUserId);
      expect(cancellations[0]?.actor_admin_id).toBeNull();
      expect(cancellations[0]?.reason).toBe(REASON);
    }, 30_000);

    it('keeps the master and the frozen price on the row', async () => {
      // The difference from re-dispatch, and deliberate: a cancelled order is
      // finished, so nothing needs the accept guard to match again — and who
      // was on the job at what price is what a dispute would have to read.
      const master = await seedMaster();
      const { order } = await orderIn('MASTER_ON_THE_WAY', master);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);

      const { rows } = await pool.query<{ master_id: string | null; price_minor: string | null }>(
        'select master_id::text as master_id, price_minor::text as price_minor from orders where id = $1',
        [order.orderId],
      );
      expect(rows[0]?.master_id).toBe(master.masterId);
      expect(rows[0]?.price_minor).toBe(String(MASTER_PRICE_MINOR));
    }, 30_000);
  });

  describe('the offers the order still owns', () => {
    it('closes them out, so no master can accept a cancelled order', async () => {
      // The acceptance criterion this suite exists for: the offer close-out is
      // the point, not the status column. An order that is CANCELLED while a
      // master's feed still shows a live offer on it is an order somebody can
      // still tap accept on.
      const master = await seedMaster();
      const { order, offerId } = await orderIn('SEARCHING', master);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);

      expect((await offersOf(order.orderId)).map((row) => row.status)).toEqual(['expired']);

      const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
        {},
      );

      expect(accepted.status).toBe(409);
      expect(await statusOf(order.orderId)).toBe('CANCELLED');
    }, 30_000);

    it('leaves an offer somebody already answered exactly as it was', async () => {
      // `accepted`, `declined` and `lost` each record something that actually
      // happened. Overwriting one would erase the history ADR-0009 reads to
      // decide who may be offered an order again.
      const master = await seedMaster();
      const { order, offerId } = await orderIn('ACCEPTED', master);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);

      const offers = await offersOf(order.orderId);
      expect(offers).toHaveLength(1);
      expect(offers[0]?.id).toBe(offerId);
      expect(offers[0]?.status).toBe('accepted');
    }, 30_000);
  });

  describe('the search the cancellation ended', () => {
    it('drops the rest of the dispatch schedule', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);
      const generation = await searchingSinceMs(order.orderId);

      // The give-up tick is an hour out, so it is genuinely still waiting.
      expect(await pendingScheduleOf(order.orderId, generation)).toContain(
        dispatchGiveUpJobId(order.orderId, generation),
      );

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);

      expect(await pendingScheduleOf(order.orderId, generation)).toEqual([]);
    }, 30_000);

    it('writes nothing when the schedule runs past the cancellation anyway', async () => {
      /**
       * Cancelling the jobs is an optimisation; the guards are what make a
       * late tick safe. Both handlers are driven here by hand — exactly the
       * at-least-once redelivery BullMQ's contract permits, and the one thing
       * the eager cancellation above cannot prevent.
       */
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);
      const generation = await searchingSinceMs(order.orderId);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);
      const trailAtCancel = await history(order.orderId);

      await handlers.resolve(DISPATCH_WAVE_JOB)({
        orderId: order.orderId,
        searchingSinceMs: generation,
        round: 1,
      });
      await handlers.resolve(DISPATCH_GIVE_UP_JOB)({
        orderId: order.orderId,
        searchingSinceMs: generation,
      });

      // No `NO_MASTER_FOUND`: a supply outcome must never overwrite a
      // customer's cancellation, because the two are different signals and
      // ADR-0015 refuses to collapse them.
      expect(await statusOf(order.orderId)).toBe('CANCELLED');
      expect(await history(order.orderId)).toEqual(trailAtCancel);
      expect((await offersOf(order.orderId)).map((row) => row.status)).toEqual(['expired']);
    }, 30_000);
  });

  describe('who may not cancel', () => {
    it('refuses another customer, without confirming the order exists', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);
      const stranger = await seedOrder();

      const response = await cancel(order.orderId, stranger.customerToken);
      const absent = await cancel(randomUUID(), stranger.customerToken);

      expect(response.status).toBe(404);
      expect(absent.status).toBe(404);
      expect((response.body as ErrorEnvelope).error.code).toBe(
        (absent.body as ErrorEnvelope).error.code,
      );
      expect(await statusOf(order.orderId)).toBe('SEARCHING');
    }, 30_000);

    it('refuses the assigned master — their route is re-dispatch, not cancellation', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('ACCEPTED', master);

      const response = await cancel(order.orderId, master.accessToken);

      // 403 rather than 404: the assigned master is a party to this order, so
      // its existence is not a secret being kept from them. What is refused is
      // the operation.
      expect(response.status).toBe(403);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_TRANSITION_NOT_PERMITTED');
      expect(await statusOf(order.orderId)).toBe('ACCEPTED');
    }, 30_000);

    it('refuses a master the order was never assigned to', async () => {
      const master = await seedMaster();
      const stranger = await seedMaster();
      const { order } = await orderIn('ACCEPTED', master);

      const response = await cancel(order.orderId, stranger.accessToken);

      expect(response.status).toBe(404);
      expect(await statusOf(order.orderId)).toBe('ACCEPTED');
    }, 30_000);

    it('refuses an unauthenticated caller', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);

      const response = await cancel(order.orderId);

      expect(response.status).toBe(401);
      expect(await statusOf(order.orderId)).toBe('SEARCHING');
    }, 30_000);
  });

  describe('what the table and the boundary refuse', () => {
    it('refuses a cancellation with no reason', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);

      const response = await cancel(order.orderId, order.customerToken, null);

      expect(response.status).toBe(422);
      expect(await statusOf(order.orderId)).toBe('SEARCHING');
    }, 30_000);

    it('refuses a blank reason, which is the same as none', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);

      const response = await cancel(order.orderId, order.customerToken, '   ');

      expect(response.status).toBe(422);
      expect(await statusOf(order.orderId)).toBe('SEARCHING');
    }, 30_000);

    it('refuses a reason longer than the trail can hold', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);

      const response = await cancel(order.orderId, order.customerToken, 'ə'.repeat(601));

      expect(response.status).toBe(422);
      expect(await statusOf(order.orderId)).toBe('SEARCHING');
    }, 30_000);

    it('refuses a second cancellation of an already-cancelled order', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('SEARCHING', master);

      expect((await cancel(order.orderId, order.customerToken)).status).toBe(200);
      const repeated = await cancel(order.orderId, order.customerToken);

      // A 409 from the conditional UPDATE, never a silent 200 — and no second
      // trail row, which an append-only table could never take back out.
      expect(repeated.status).toBe(409);
      expect((repeated.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect(
        (await history(order.orderId)).filter((row) => row.to_status === 'CANCELLED'),
      ).toHaveLength(1);
    }, 30_000);

    it('refuses a cancellation of an order that is already finished', async () => {
      const master = await seedMaster();
      const { order } = await orderIn('IN_PROGRESS', master);

      const completed = await post(`/orders/${order.orderId}/transitions`, master.accessToken).send(
        { to: 'COMPLETED' },
      );
      expect(completed.status).toBe(200);

      const response = await cancel(order.orderId, order.customerToken);

      // `COMPLETED -> CANCELLED` is not an edge. The work happened; the
      // customer's route from here is a dispute, which is EPIC 12's.
      expect(response.status).toBe(409);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect(await statusOf(order.orderId)).toBe('COMPLETED');
    }, 30_000);
  });

  describe('two taps at once', () => {
    it('cancels exactly once, and writes exactly one trail row', async () => {
      // A read-then-write implementation passes every sequential test above
      // and fails here. The conditional UPDATE is what makes the loser lose,
      // and the loser must not leave a second trail row behind.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const master = await seedMaster();
        const { order } = await orderIn('SEARCHING', master);

        const [first, second] = await Promise.all([
          cancel(order.orderId, order.customerToken),
          cancel(order.orderId, order.customerToken),
        ]);

        const codes = [first.status, second.status].sort((a, b) => a - b);
        expect(codes).toEqual([200, 409]);

        expect(
          (await history(order.orderId)).filter((row) => row.to_status === 'CANCELLED'),
        ).toHaveLength(1);
        expect(await statusOf(order.orderId)).toBe('CANCELLED');
      }
    }, 60_000);
  });
});
