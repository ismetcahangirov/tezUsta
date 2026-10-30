import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminCustomerDetail, AdminMasterDetail, Order } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * The cancellation rules over real HTTP
 * ([ADR-0068](../../../docs/decisions/ADR-0068-cancellation-rules.md), #461).
 *
 * **Time is moved by writing the clock's inputs, not by waiting.** Every rule
 * here is a duration measured from `accepted_at` or `promised_arrival_at`, and
 * the server reads both against the database's `now()`. Backdating them puts
 * an order exactly where a test wants it on the clock, with a margin of
 * seconds either side of each boundary rather than the boundary itself — the
 * request is not instantaneous, and a test sitting on the second would be a
 * test of how fast the machine is.
 *
 * Backdating `accepted_at` also quiets the arrival-promise job for that
 * accept: it writes only for the accept it was scheduled by, matched on the
 * millisecond, so a test that sets the promise itself is the only writer.
 *
 * The durations are the defaults — 60 s, 120 s, 10 min — because the suite is
 * about the rules the owner decided, and the configuration that carries them
 * is `parse-env.test.ts`'s.
 */

/** `users.email` is unique among live rows. */
let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const MASTER_PRICE_MINOR = 6700;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';
const REASON = 'Planlar dəyişdi.';

/** ADR-0068's defaults, which this suite runs under. */
const HANDBACK_WINDOW_SECONDS = 60;
const FREE_GRACE_SECONDS = 120;
const LATE_ARRIVAL_MINUTES = 10;

/** How far either side of a boundary a test stands. */
const MARGIN_SECONDS = 5;

/** The statuses a master may hand an order back from. */
const HANDBACK_FROM = ['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED'] as const;

type ActiveStatus = (typeof HANDBACK_FROM)[number] | 'IN_PROGRESS';

const ADVANCE_PATH = ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'] as const;

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededCustomer {
  readonly customerId: string;
  readonly accessToken: string;
}

interface OrderState {
  readonly status: string;
  readonly cancellation_kind: string | null;
  readonly redispatch_count: number;
}

describe('the cancellation rules (ADR-0068, #461)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let adminRepository: AdminRepository;
  let adminSessions: AdminSessionService;
  let serviceId: string;
  let adminToken: string;

  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function send(method: 'get' | 'post', path: string, accessToken: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${accessToken}`);
  }

  function codeOf(response: request.Response): string {
    return (response.body as ErrorEnvelope).error.code;
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ email: nextEmail(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  /** A master eligible on every term the accept path re-checks. */
  async function seedMaster(): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await send('post', '/masters', caller.accessToken).send({
      displayName: 'Usta Anar',
    });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters set verification_status = 'active', is_available = true where id = $1`,
      [masterId],
    );
    await grantTestSubscription(pool, masterId);
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

  async function seedCustomer(): Promise<SeededCustomer> {
    const caller = await signIn();
    const profile = await send('post', '/customers', caller.accessToken).send({
      displayName: 'Müştəri',
    });
    expect(profile.status).toBe(201);
    return { customerId: (profile.body as { id: string }).id, accessToken: caller.accessToken };
  }

  /** A real `SEARCHING` order, placed by `customer` (a new one by default). */
  async function seedOrder(
    customer?: SeededCustomer,
  ): Promise<{ orderId: string; customer: SeededCustomer }> {
    const owner = customer ?? (await seedCustomer());
    const address = await send('post', '/addresses', owner.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);

    const order = await send('post', '/orders', owner.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    return { orderId: (order.body as { id: string }).id, customer: owner };
  }

  /** An order walked to `to` by the real accept and transition paths. */
  async function orderIn(
    to: ActiveStatus,
    master: SeededMaster,
    customer?: SeededCustomer,
  ): Promise<{ orderId: string; customer: SeededCustomer }> {
    const seeded = await seedOrder(customer);
    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, seeded.orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );
    const accepted = await send(
      'post',
      `/masters/me/offers/${offerId}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);

    if (to !== 'ACCEPTED') {
      for (const next of ADVANCE_PATH) {
        const advanced = await send(
          'post',
          `/orders/${seeded.orderId}/transitions`,
          master.accessToken,
        ).send({ to: next });
        expect(advanced.status).toBe(200);
        if (next === to) {
          break;
        }
      }
    }
    return seeded;
  }

  /**
   * Puts the accept `secondsAgo` in the past and writes the promise outright —
   * `null`, or that many minutes before the master's first arrival (or before
   * now, when they have not arrived). A negative figure is a promise still
   * ahead of the arrival.
   */
  async function setClock(
    orderId: string,
    clock: { acceptedSecondsAgo: number; promiseMinutesBeforeArrival?: number | null },
  ): Promise<void> {
    const minutes = clock.promiseMinutesBeforeArrival ?? null;
    await pool.query(
      `update orders
          set accepted_at = now() - make_interval(secs => $2::double precision),
              promised_arrival_at = case when $3::double precision is null then null else
                coalesce(
                  (select min(created_at) from order_status_history
                    where order_id = $1 and to_status = 'MASTER_ARRIVED'),
                  now()
                ) - make_interval(secs => $3::double precision * 60) end,
              arrival_promise_source = case when $3::double precision is null then null
                else 'estimate'::arrival_promise_source end
        where id = $1`,
      [orderId, clock.acceptedSecondsAgo, minutes],
    );
  }

  async function orderState(orderId: string): Promise<OrderState> {
    const { rows } = await pool.query<OrderState>(
      'select status, cancellation_kind, redispatch_count from orders where id = $1',
      [orderId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`order ${orderId} is missing`);
    }
    return row;
  }

  function handBack(orderId: string, token: string) {
    return send('post', `/orders/${orderId}/transitions`, token).send({
      to: 'SEARCHING',
      reason: 'Gələ bilmirəm.',
    });
  }

  function cancel(orderId: string, token: string) {
    return send('post', `/orders/${orderId}/transitions`, token).send({
      to: 'CANCELLED',
      reason: REASON,
    });
  }

  function adminOverride(orderId: string, to: string) {
    return send('post', `/admin/orders/${orderId}/transitions`, adminToken).send({
      to,
      reason: 'Usta zəng etdi, gələ bilmir.',
    });
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
    set('MAX_OPEN_ORDERS_PER_CUSTOMER', '100');

    // The live engine reaches nobody, the way `order-cancellation.e2e.test.ts`
    // does it: this suite writes its own `order_offers` row per order.
    set('DISPATCH_INITIAL_RADIUS_M', '1');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    adminRepository = app.get(AdminRepository);
    adminSessions = app.get(AdminSessionService);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    const createdAdmin = await adminRepository.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
      roles: ['super_admin'],
    });
    adminToken = (await adminSessions.start(createdAdmin.id)).accessToken;
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

  describe('the master’s hand-back window (§ 4)', () => {
    it.each(HANDBACK_FROM)(
      'lets the master hand back from %s inside the minute',
      async (from) => {
        const master = await seedMaster();
        const { orderId } = await orderIn(from, master);
        await setClock(orderId, { acceptedSecondsAgo: HANDBACK_WINDOW_SECONDS - MARGIN_SECONDS });

        const response = await handBack(orderId, master.accessToken);

        expect(response.status).toBe(200);
        expect((response.body as Order).status).toBe('SEARCHING');
        expect((await orderState(orderId)).redispatch_count).toBe(1);
      },
      30_000,
    );

    it.each(HANDBACK_FROM)(
      'refuses the master from %s once the minute has passed, and changes nothing',
      async (from) => {
        const master = await seedMaster();
        const { orderId } = await orderIn(from, master);
        await setClock(orderId, { acceptedSecondsAgo: HANDBACK_WINDOW_SECONDS + MARGIN_SECONDS });
        const { rows: before } = await pool.query<{ n: number }>(
          'select count(*)::int as n from order_status_history where order_id = $1',
          [orderId],
        );

        const response = await handBack(orderId, master.accessToken);

        expect(response.status).toBe(409);
        expect(codeOf(response)).toBe('ORDER_HANDBACK_WINDOW_CLOSED');
        expect((response.body as ErrorEnvelope).error.details).toEqual({
          windowSeconds: HANDBACK_WINDOW_SECONDS,
        });
        const state = await orderState(orderId);
        expect(state.status).toBe(from);
        expect(state.redispatch_count).toBe(0);
        const { rows: after } = await pool.query<{ n: number }>(
          'select count(*)::int as n from order_status_history where order_id = $1',
          [orderId],
        );
        expect(after[0]?.n).toBe(before[0]?.n);
      },
      30_000,
    );

    it('still lets an admin send the order back out after the minute', async () => {
      const master = await seedMaster();
      const { orderId } = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(orderId, { acceptedSecondsAgo: 3600 });

      expect((await handBack(orderId, master.accessToken)).status).toBe(409);
      const response = await adminOverride(orderId, 'SEARCHING');

      expect(response.status).toBe(200);
      expect((await orderState(orderId)).status).toBe('SEARCHING');
    }, 30_000);

    it('gives the master no way out of IN_PROGRESS, inside the minute or not (§ 5)', async () => {
      const master = await seedMaster();
      const { orderId } = await orderIn('IN_PROGRESS', master);
      await setClock(orderId, { acceptedSecondsAgo: 1 });

      const response = await handBack(orderId, master.accessToken);

      expect(response.status).toBe(409);
      expect(codeOf(response)).not.toBe('ORDER_HANDBACK_WINDOW_CLOSED');
      expect((await orderState(orderId)).status).toBe('IN_PROGRESS');
    }, 30_000);
  });

  describe('how a customer’s cancellation is classed (§ 1)', () => {
    async function cancelledKind(orderId: string, token: string): Promise<string | null> {
      const response = await cancel(orderId, token);
      expect(response.status).toBe(200);
      const state = await orderState(orderId);
      expect(state.status).toBe('CANCELLED');
      return state.cancellation_kind;
    }

    it('is free while the order is still searching', async () => {
      const { orderId, customer } = await seedOrder();
      expect(await cancelledKind(orderId, customer.accessToken)).toBe('free');
    }, 30_000);

    it('is free in ACCEPTED inside the grace, and late just after it', async () => {
      const master = await seedMaster();
      const early = await orderIn('ACCEPTED', master);
      await setClock(early.orderId, { acceptedSecondsAgo: FREE_GRACE_SECONDS - MARGIN_SECONDS });
      expect(await cancelledKind(early.orderId, early.customer.accessToken)).toBe('free');

      const late = await orderIn('ACCEPTED', master);
      await setClock(late.orderId, { acceptedSecondsAgo: FREE_GRACE_SECONDS + MARGIN_SECONDS });
      expect(await cancelledKind(late.orderId, late.customer.accessToken)).toBe('late');
    }, 30_000);

    it('gives no grace once the master is on the way, however soon after accept', async () => {
      const master = await seedMaster();
      const { orderId, customer } = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(orderId, { acceptedSecondsAgo: 10 });
      expect(await cancelledKind(orderId, customer.accessToken)).toBe('late');
    }, 30_000);

    it('is free when the master has not arrived and is past the promise by more than the threshold', async () => {
      const master = await seedMaster();
      const overdue = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(overdue.orderId, {
        acceptedSecondsAgo: 3600,
        promiseMinutesBeforeArrival: LATE_ARRIVAL_MINUTES + 1,
      });
      expect(await cancelledKind(overdue.orderId, overdue.customer.accessToken)).toBe(
        'master_late',
      );

      const nearly = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(nearly.orderId, {
        acceptedSecondsAgo: 3600,
        promiseMinutesBeforeArrival: LATE_ARRIVAL_MINUTES - 1,
      });
      expect(await cancelledKind(nearly.orderId, nearly.customer.accessToken)).toBe('late');
    }, 30_000);

    it('reads lateness from the arrival, so a master who came late frees the customer later on', async () => {
      const master = await seedMaster();
      const { orderId, customer } = await orderIn('MASTER_ARRIVED', master);
      await setClock(orderId, {
        acceptedSecondsAgo: 3600,
        promiseMinutesBeforeArrival: LATE_ARRIVAL_MINUTES + 1,
      });
      expect(await cancelledKind(orderId, customer.accessToken)).toBe('master_late');
    }, 30_000);

    it('does not free a customer cancelling an on-time job long after its promise', async () => {
      // The master arrived a minute early; the promise is now an hour gone.
      // "The promise is long past" would class this free — arrival is what counts.
      const master = await seedMaster();
      const { orderId, customer } = await orderIn('IN_PROGRESS', master);
      await setClock(orderId, { acceptedSecondsAgo: 7200, promiseMinutesBeforeArrival: -1 });
      expect(await cancelledKind(orderId, customer.accessToken)).toBe('late');
    }, 30_000);

    it('is late when no promise was ever written and the grace is over', async () => {
      const master = await seedMaster();
      const { orderId, customer } = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(orderId, { acceptedSecondsAgo: 3600, promiseMinutesBeforeArrival: null });
      expect(await cancelledKind(orderId, customer.accessToken)).toBe('late');
    }, 30_000);

    it('classes nothing an admin cancels: it is no mark against the customer', async () => {
      const master = await seedMaster();
      const { orderId } = await orderIn('MASTER_ON_THE_WAY', master);
      await setClock(orderId, { acceptedSecondsAgo: 3600 });

      expect((await adminOverride(orderId, 'CANCELLED')).status).toBe(200);
      const state = await orderState(orderId);
      expect(state.status).toBe('CANCELLED');
      expect(state.cancellation_kind).toBeNull();
    }, 30_000);
  });

  describe('the counts, which only an admin sees (§§ 3, 6 and 7)', () => {
    it('counts a customer’s late cancellations on their admin file, and nothing else', async () => {
      const customer = await seedCustomer();
      const master = await seedMaster();

      const free = await seedOrder(customer);
      expect((await cancel(free.orderId, customer.accessToken)).status).toBe(200);

      const late = await orderIn('MASTER_ON_THE_WAY', master, customer);
      await setClock(late.orderId, { acceptedSecondsAgo: 3600 });
      expect((await cancel(late.orderId, customer.accessToken)).status).toBe(200);

      const excused = await orderIn('MASTER_ON_THE_WAY', master, customer);
      await setClock(excused.orderId, {
        acceptedSecondsAgo: 3600,
        promiseMinutesBeforeArrival: LATE_ARRIVAL_MINUTES + 5,
      });
      expect((await cancel(excused.orderId, customer.accessToken)).status).toBe(200);

      const file = await send('get', `/admin/customers/${customer.customerId}`, adminToken);
      expect(file.status).toBe(200);
      const counts = (file.body as AdminCustomerDetail).orderCounts;
      expect(counts.cancelled).toBe(3);
      expect(counts.lateCancellations).toBe(1);

      // The customer's own view of the same order carries no class.
      const own = await send('get', `/orders/${late.orderId}`, customer.accessToken);
      expect(own.status).toBe(200);
      expect(own.body).not.toHaveProperty('cancellationKind');
      expect(JSON.stringify(own.body)).not.toContain('lateCancellations');
    }, 60_000);

    it('counts a master’s own hand-backs and late arrivals on their admin file', async () => {
      const master = await seedMaster();

      // One hand-back of the master's own: counted.
      const handedBack = await orderIn('ACCEPTED', master);
      expect((await handBack(handedBack.orderId, master.accessToken)).status).toBe(200);

      // One re-dispatch an admin performed: not the master's act, not counted.
      const adminMoved = await orderIn('ACCEPTED', master);
      expect((await adminOverride(adminMoved.orderId, 'SEARCHING')).status).toBe(200);

      // Arrived eleven minutes after the promise: one late arrival.
      const lateJob = await orderIn('MASTER_ARRIVED', master);
      await setClock(lateJob.orderId, {
        acceptedSecondsAgo: 3600,
        promiseMinutesBeforeArrival: LATE_ARRIVAL_MINUTES + 1,
      });
      // A master holds one job at a time; the order keeps naming them once it ends.
      expect((await adminOverride(lateJob.orderId, 'CANCELLED')).status).toBe(200);

      // Arrived a minute early: on time.
      const onTime = await orderIn('MASTER_ARRIVED', master);
      await setClock(onTime.orderId, { acceptedSecondsAgo: 3600, promiseMinutesBeforeArrival: -1 });

      const file = await send('get', `/admin/masters/${master.masterId}`, adminToken);
      expect(file.status).toBe(200);
      expect((file.body as AdminMasterDetail).jobRecord).toEqual({
        handBacks: 1,
        lateArrivals: 1,
      });

      // The master's own surfaces carry neither count.
      for (const path of ['/masters/me', '/masters/me/jobs/current']) {
        const own = await send('get', path, master.accessToken);
        expect(own.status).toBe(200);
        expect(JSON.stringify(own.body)).not.toMatch(/jobRecord|handBacks|lateArrivals/);
      }
    }, 60_000);
  });
});
