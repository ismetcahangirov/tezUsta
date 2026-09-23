import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Order } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Advancing an accepted order over real HTTP (issue #134, EPIC 8).
 *
 * Before this, an order that reached `ACCEPTED` stopped there forever: the
 * transition table and `assertOrderTransition` existed from EPIC 6, and
 * nothing invoked them. What this suite owns is the four edges that carry no
 * side effect beyond the status and its audit row. The route has since learned
 * three more targets, and each is asserted where its side effects are:
 * `order-cancellation.e2e.test.ts` (#135), `order-redispatch.e2e.test.ts`
 * (#136), and the admin override's own suite.
 *
 * **The invalid transitions are not an afterthought here.** CLAUDE.md §13
 * requires every state-machine transition to be tested *including the invalid
 * ones*, and a state machine tested only forwards passes with the entire edge
 * table deleted: every advance would still work, and so would every skip.
 * Each rejection below therefore names one specific thing the table forbids.
 *
 * **The concurrency test is the reason this is an integration suite.** The
 * guard is a conditional `UPDATE`, and a read-then-write implementation passes
 * every sequential test in this file. Only two genuinely parallel requests
 * tell the two apart.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const MASTER_PRICE_MINOR = 6700;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

/** The walk this endpoint exists for, in order. */
const ADVANCE_PATH = ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED'] as const;

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly addressId: string;
  readonly customerToken: string;
}

interface HistoryRow {
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly actor_admin_id: string | null;
  readonly reason: string | null;
}

describe('advancing an accepted order over HTTP (issue #134)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
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

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
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
    };
  }

  /**
   * An order in `ACCEPTED`, reached through the **real** accept path rather
   * than by writing the status: the thing under test is what happens after a
   * genuine accept, and a hand-written `ACCEPTED` row would also skip the
   * history row every assertion here counts against.
   */
  async function acceptedOrder(master: SeededMaster): Promise<SeededOrder> {
    const order = await seedOrder();
    const offerId = randomUUID();

    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, order.orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );

    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);

    return order;
  }

  function advance(order: SeededOrder, token: string, to: string, reason?: string) {
    return post(`/orders/${order.orderId}/transitions`, token).send(
      reason === undefined ? { to } : { to, reason },
    );
  }

  async function history(orderId: string): Promise<HistoryRow[]> {
    const { rows } = await pool.query<HistoryRow>(
      `select from_status, to_status, actor_kind, actor_user_id, actor_admin_id, reason
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
     * `master-offers.e2e.test.ts` does it and for the same reason: this suite
     * writes its own `order_offers` row per order, and a broadcast into the
     * same table would collide on `order_offers_order_master_unique`. A
     * one-metre initial radius with a single wave reaches none of the masters
     * seeded 1200 m away, and no give-up tick fires inside a test's lifetime.
     *
     * `DISPATCH_MAX_RADIUS_M` is left alone — the accept path clamps against
     * it too, so lowering it would refuse the very master each test invites.
     */
    set('DISPATCH_INITIAL_RADIUS_M', '1');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Bound once, here: the concurrency test fires two requests at one
    // instant, and letting supertest start the server per request races two
    // `listen` calls on the same socket (`master-offers.e2e.test.ts`).
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

  describe('the assigned master walking the order forward', () => {
    it('advances one status at a time, from ACCEPTED to COMPLETED', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ADVANCE_PATH) {
        const response = await advance(order, master.accessToken, to);

        expect(response.status).toBe(200);
        expect((response.body as Order).status).toBe(to);
        expect(await statusOf(order.orderId)).toBe(to);
      }
    });

    it('records each step in the trail, attributed to that master', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ADVANCE_PATH) {
        expect((await advance(order, master.accessToken, to, 'Yoldayam')).status).toBe(200);
      }

      const rows = await history(order.orderId);
      const advanced = rows.filter((row) => ADVANCE_PATH.includes(row.to_status as never));

      expect(advanced.map((row) => `${row.from_status}->${row.to_status}`)).toEqual([
        'ACCEPTED->MASTER_ON_THE_WAY',
        'MASTER_ON_THE_WAY->MASTER_ARRIVED',
        'MASTER_ARRIVED->IN_PROGRESS',
        'IN_PROGRESS->COMPLETED',
      ]);

      for (const row of advanced) {
        expect(row.actor_kind).toBe('master');
        expect(row.actor_user_id).toBe(master.userId);
        expect(row.actor_admin_id).toBeNull();
        expect(row.reason).toBe('Yoldayam');
      }
    });

    it('keeps the reason optional', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await advance(order, master.accessToken, 'MASTER_ON_THE_WAY')).status).toBe(200);

      const rows = await history(order.orderId);
      expect(rows.at(-1)?.reason).toBeNull();
    });

    it('answers with the same order shape GET /orders/:id serves', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const advanced = await advance(order, master.accessToken, 'MASTER_ON_THE_WAY');
      const read = await get(`/orders/${order.orderId}`, order.customerToken);

      expect(read.status).toBe(200);
      // The customer's read adds their unread message count (issue #182); a
      // transition answers the bare order, to a master as often as to a
      // customer, so the count is the one field the two do not share.
      expect({ ...(advanced.body as object), unreadMessageCount: 0 }).toEqual(read.body);
    });
  });

  describe('who may not advance it', () => {
    it('refuses a master the order was not assigned to, without confirming it exists', async () => {
      const assigned = await seedMaster();
      const stranger = await seedMaster();
      const order = await acceptedOrder(assigned);

      const response = await advance(order, stranger.accessToken, 'MASTER_ON_THE_WAY');

      // 404, never 403: a 403 would make this route a way to ask whether a
      // given id is somebody's order.
      expect(response.status).toBe(404);
      expect(await statusOf(order.orderId)).toBe('ACCEPTED');
    });

    it('refuses the order’s own customer on every advancing edge', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      /**
       * Asked at each status in turn rather than four times against a
       * stationary order, because only then is the edge genuinely available:
       * `ACCEPTED -> IN_PROGRESS` is refused for being absent from the table,
       * which proves nothing about who may walk it. Here the edge exists,
       * leaves from where the order actually is, and is refused because of
       * *who is asking* — which is the rule under test, and the reason this is
       * a 403 with `ORDER_TRANSITION_NOT_PERMITTED` rather than a 409.
       *
       * The customer reaches the service at all only because issue #135 opened
       * this route to them for cancellation. Before that a role guard refused
       * them at the door and this test could not tell the two refusals apart.
       */
      for (const to of ADVANCE_PATH) {
        const refused = await advance(order, order.customerToken, to);

        expect(refused.status).toBe(403);
        expect((refused.body as ErrorEnvelope).error.code).toBe('ORDER_TRANSITION_NOT_PERMITTED');

        expect((await advance(order, master.accessToken, to)).status).toBe(200);
      }

      expect(await statusOf(order.orderId)).toBe('COMPLETED');
    });

    it('refuses an unauthenticated caller', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await post(`/orders/${order.orderId}/transitions`).send({
        to: 'MASTER_ON_THE_WAY',
      });

      expect(response.status).toBe(401);
    });

    it('answers 404 for an order id that does not exist', async () => {
      const master = await seedMaster();

      const response = await post(`/orders/${randomUUID()}/transitions`, master.accessToken).send({
        to: 'MASTER_ON_THE_WAY',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('the edges the table does not contain', () => {
    it('refuses a skipped step', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await advance(order, master.accessToken, 'IN_PROGRESS');

      expect(response.status).toBe(409);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect(await statusOf(order.orderId)).toBe('ACCEPTED');
    });

    it('refuses a step backwards', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await advance(order, master.accessToken, 'MASTER_ON_THE_WAY')).status).toBe(200);
      expect((await advance(order, master.accessToken, 'MASTER_ARRIVED')).status).toBe(200);

      const response = await advance(order, master.accessToken, 'MASTER_ON_THE_WAY');

      expect(response.status).toBe(409);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect(await statusOf(order.orderId)).toBe('MASTER_ARRIVED');
    });

    it('refuses to repeat a step the order has already taken', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await advance(order, master.accessToken, 'MASTER_ON_THE_WAY')).status).toBe(200);
      const repeated = await advance(order, master.accessToken, 'MASTER_ON_THE_WAY');

      expect(repeated.status).toBe(409);
      // DRAFT->SEARCHING, SEARCHING->ACCEPTED, ACCEPTED->MASTER_ON_THE_WAY.
      // The repeat added nothing, which is the point: the trail is append-only,
      // so a duplicate written here could never be taken back out.
      expect(await history(order.orderId)).toHaveLength(3);
    });

    it('moves nothing once the order is finished', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ADVANCE_PATH) {
        expect((await advance(order, master.accessToken, to)).status).toBe(200);
      }

      // `COMPLETED` leads on to payment and dispute, neither of which this
      // endpoint may drive: they are not a master's edges.
      for (const to of ADVANCE_PATH) {
        expect((await advance(order, master.accessToken, to)).status).toBe(409);
      }

      expect(await statusOf(order.orderId)).toBe('COMPLETED');
    });
  });

  describe('what the request body may say', () => {
    it.each(['PAID', 'DISPUTED', 'NO_MASTER_FOUND', 'DRAFT', 'not-a-status', ''])(
      'refuses %j as a target',
      async (to) => {
        const master = await seedMaster();
        const order = await acceptedOrder(master);

        const response = await advance(order, master.accessToken, to);

        expect(response.status).toBe(422);
        expect(await statusOf(order.orderId)).toBe('ACCEPTED');
      },
    );

    it('refuses an unknown property', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await post(`/orders/${order.orderId}/transitions`, master.accessToken).send({
        to: 'MASTER_ON_THE_WAY',
        masterId: master.masterId,
      });

      expect(response.status).toBe(422);
    });

    it('refuses a reason longer than the trail can hold', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await advance(
        order,
        master.accessToken,
        'MASTER_ON_THE_WAY',
        'ə'.repeat(601),
      );

      expect(response.status).toBe(422);
    });
  });

  describe('two taps at once', () => {
    it('advances the order exactly once, and writes exactly one trail row', async () => {
      // A read-then-write implementation passes every sequential test above
      // and fails here: both requests read `ACCEPTED`, both write
      // `MASTER_ON_THE_WAY`, and the trail ends up with two rows claiming the
      // same transition. The conditional UPDATE is what makes the loser lose.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const master = await seedMaster();
        const order = await acceptedOrder(master);

        const [first, second] = await Promise.all([
          advance(order, master.accessToken, 'MASTER_ON_THE_WAY'),
          advance(order, master.accessToken, 'MASTER_ON_THE_WAY'),
        ]);

        const codes = [first.status, second.status].sort((a, b) => a - b);
        expect(codes).toEqual([200, 409]);

        const advanced = (await history(order.orderId)).filter(
          (row) => row.to_status === 'MASTER_ON_THE_WAY',
        );
        expect(advanced).toHaveLength(1);
        expect(await statusOf(order.orderId)).toBe('MASTER_ON_THE_WAY');
      }
    });
  });
});
