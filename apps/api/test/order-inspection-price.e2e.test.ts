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
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { PRICE_DECLINED_REASON } from '../src/modules/orders/orders.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * The inspection price over real HTTP
 * ([ADR-0060](docs/decisions/ADR-0060-inspection-price-approval.md)).
 *
 * The master quotes on arrival, may replace the quote until it is approved,
 * and cannot start before the customer approves the exact amount shown. A
 * decline cancels the order. A fixed-price order is untouched by all of it.
 *
 * Every refusal names one specific thing the ADR forbids, for the reason
 * `order-transitions.e2e.test.ts` gives: a rule tested only on its happy path
 * passes with the rule deleted.
 */

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const FIXED_PRICE_MINOR = 6700;
const DESCRIPTION = 'Kondisioner soyutmur, baxmaq lazımdır.';

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customerUserId: string;
  readonly customerToken: string;
}

interface PriceRow {
  readonly pricing_kind: string;
  readonly price_minor: string | null;
  readonly price_approved_at: Date | null;
  readonly price_declined_at: Date | null;
  readonly cancellation_kind: string | null;
  readonly status: string;
}

describe('the inspection price: quote on arrival, approve before work (ADR-0060)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let adminToken: string;
  let fixedServiceId: string;
  let inspectionServiceId: string;

  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function send(method: 'post' | 'put', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`);
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ email: nextEmail(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  /** A master offering both services: a price for the fixed one, none for the inspection one. */
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
       values ($1, $2, $3, true), ($1, $4, null, true)`,
      [masterId, fixedServiceId, FIXED_PRICE_MINOR, inspectionServiceId],
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

  /** A real order for `serviceId`, accepted by `master` through the real accept path. */
  async function acceptedOrder(master: SeededMaster, serviceId: string): Promise<SeededOrder> {
    const caller = await signIn();
    expect(
      (await send('post', '/customers', caller.accessToken).send({ displayName: 'Müştəri' }))
        .status,
    ).toBe(201);

    const address = await send('post', '/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);

    const created = await send('post', '/orders', caller.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(201);
    const orderId = (created.body as { id: string }).id;

    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );
    const accepted = await send(
      'post',
      `/masters/me/offers/${offerId}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);

    return { orderId, customerUserId: caller.userId, customerToken: caller.accessToken };
  }

  async function arrivedOrder(master: SeededMaster, serviceId: string): Promise<SeededOrder> {
    const order = await acceptedOrder(master, serviceId);
    for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED']) {
      expect((await transition(order, master.accessToken, to)).status).toBe(200);
    }
    return order;
  }

  function transition(order: SeededOrder, token: string, to: string, reason?: string) {
    return send('post', `/orders/${order.orderId}/transitions`, token).send(
      reason === undefined ? { to } : { to, reason },
    );
  }

  function quote(order: SeededOrder, token: string, amountMinor: unknown) {
    return send('put', `/orders/${order.orderId}/price`, token).send({ amountMinor });
  }

  function approve(order: SeededOrder, token: string, amountMinor: number) {
    return send('post', `/orders/${order.orderId}/price/approval`, token).send({ amountMinor });
  }

  function decline(order: SeededOrder, token: string, amountMinor: number) {
    return send('post', `/orders/${order.orderId}/price/decline`, token).send({ amountMinor });
  }

  async function priceRow(orderId: string): Promise<PriceRow> {
    const { rows } = await pool.query<PriceRow>(
      `select pricing_kind, price_minor, price_approved_at, price_declined_at,
              cancellation_kind, status
         from orders where id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`order ${orderId} is missing`);
    }
    return row;
  }

  async function priceEvents(orderId: string): Promise<{ kind: string; amount: number }[]> {
    const { rows } = await pool.query<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor from order_price_events
        where order_id = $1 order by created_at, id`,
      [orderId],
    );
    return rows.map((row) => ({ kind: row.kind, amount: Number(row.amount_minor) }));
  }

  function codeOf(response: request.Response): string {
    return (response.body as ErrorEnvelope).error.code;
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
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    // The live engine reaches nobody, as in `order-transitions.e2e.test.ts`:
    // each test writes its own offer row.
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

    const admin = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
      roles: ['super_admin'],
    });
    adminToken = (await app.get(AdminSessionService).start(admin.id)).accessToken;

    pool = new Pool({ connectionString: database.url });

    const pick = async (kind: string): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `select id from services where is_active and pricing_kind = $1 order by id limit 1`,
        [kind],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error(`the seeded catalogue should contain an active ${kind} service`);
      }
      return id;
    };
    fixedServiceId = await pick('fixed');
    inspectionServiceId = await pick('inspection');
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

  it('copies the pricing shape onto the order at creation, with no price until a quote', async () => {
    const master = await seedMaster();
    const order = await acceptedOrder(master, inspectionServiceId);

    const row = await priceRow(order.orderId);
    expect(row.pricing_kind).toBe('inspection');
    expect(row.price_minor).toBeNull();
    expect(row.price_approved_at).toBeNull();

    const read = await request(app.getHttpServer())
      .get(`/orders/${order.orderId}`)
      .set('authorization', `Bearer ${order.customerToken}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ pricingKind: 'inspection', priceApprovedAt: null });

    const job = await request(app.getHttpServer())
      .get('/masters/me/jobs/current')
      .set('authorization', `Bearer ${master.accessToken}`);
    expect(job.status).toBe(200);
    expect((job.body as { job: unknown }).job).toMatchObject({
      pricingKind: 'inspection',
      priceMinor: null,
      priceApprovedAt: null,
    });
  });

  it('walks quote, re-quote, a stale approval, approval, then the start', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);

    // Nothing to approve yet, and nothing to start.
    const early = await approve(order, order.customerToken, 5000);
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('ORDER_PRICE_STALE');

    const blocked = await transition(order, master.accessToken, 'IN_PROGRESS');
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('ORDER_PRICE_NOT_APPROVED');

    const first = await quote(order, master.accessToken, 5000);
    expect(first.status).toBe(200);
    expect(first.body as Order).toMatchObject({ priceMinor: 5000, priceApprovedAt: null });

    const second = await quote(order, master.accessToken, 4500);
    expect(second.status).toBe(200);

    // The customer approves the figure they saw first: refused, and told the new one.
    const stale = await approve(order, order.customerToken, 5000);
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('ORDER_PRICE_STALE');
    expect((stale.body as ErrorEnvelope).error.details).toMatchObject({
      status: 'MASTER_ARRIVED',
      priceMinor: 4500,
      priceApproved: false,
    });
    expect((await priceRow(order.orderId)).price_approved_at).toBeNull();

    const approved = await approve(order, order.customerToken, 4500);
    expect(approved.status).toBe(200);
    expect((approved.body as Order).priceApprovedAt).not.toBeNull();

    // Frozen once approved.
    const late = await quote(order, master.accessToken, 9000);
    expect(late.status).toBe(409);
    expect(codeOf(late)).toBe('ORDER_PRICE_NOT_QUOTABLE');
    expect((await approve(order, order.customerToken, 4500)).status).toBe(409);

    const started = await transition(order, master.accessToken, 'IN_PROGRESS');
    expect(started.status).toBe(200);
    expect((started.body as Order).priceMinor).toBe(4500);

    expect(await priceEvents(order.orderId)).toEqual([
      { kind: 'quoted', amount: 5000 },
      { kind: 'quoted', amount: 4500 },
      { kind: 'approved', amount: 4500 },
    ]);
  });

  it('refuses a quote before the master has arrived', async () => {
    const master = await seedMaster();
    const order = await acceptedOrder(master, inspectionServiceId);

    const response = await quote(order, master.accessToken, 5000);
    expect(response.status).toBe(409);
    expect(codeOf(response)).toBe('ORDER_PRICE_NOT_QUOTABLE');
    expect((response.body as ErrorEnvelope).error.details).toMatchObject({
      status: 'ACCEPTED',
      pricingKind: 'inspection',
    });
    expect(await priceEvents(order.orderId)).toEqual([]);
  });

  it('leaves a fixed-price order alone: no quote, no approval, and the start is not gated', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, fixedServiceId);

    expect((await priceRow(order.orderId)).pricing_kind).toBe('fixed');

    const quoted = await quote(order, master.accessToken, 5000);
    expect(quoted.status).toBe(409);
    expect(codeOf(quoted)).toBe('ORDER_PRICE_NOT_QUOTABLE');

    const approved = await approve(order, order.customerToken, FIXED_PRICE_MINOR);
    expect(approved.status).toBe(409);
    expect(codeOf(approved)).toBe('ORDER_PRICE_NOT_QUOTABLE');

    const started = await transition(order, master.accessToken, 'IN_PROGRESS');
    expect(started.status).toBe(200);
    expect((started.body as Order).priceMinor).toBe(FIXED_PRICE_MINOR);
  });

  it('lets only the master quote and only the customer approve or decline, and hides the order from strangers', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);
    const stranger = await signIn();
    expect(
      (await send('post', '/customers', stranger.accessToken).send({ displayName: 'Kənar' }))
        .status,
    ).toBe(201);

    // `@Roles` turns a caller with the wrong role away before the order is read.
    expect((await quote(order, order.customerToken, 5000)).status).toBe(403);
    expect((await quote(order, stranger.accessToken, 5000)).status).toBe(403);

    expect((await quote(order, master.accessToken, 5000)).status).toBe(200);

    expect((await approve(order, stranger.accessToken, 5000)).status).toBe(404);
    expect((await decline(order, stranger.accessToken, 5000)).status).toBe(404);

    expect(await priceRow(order.orderId)).toMatchObject({
      status: 'MASTER_ARRIVED',
      price_approved_at: null,
    });
  });

  it('refuses an amount that is not a positive whole number of minor units', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);

    for (const amountMinor of [0, -100, 12.5, '5000', null]) {
      expect((await quote(order, master.accessToken, amountMinor)).status).toBe(422);
    }
    expect(await priceEvents(order.orderId)).toEqual([]);
  });

  it('cancels the order on a decline of the current quote, recorded as a decline', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);
    expect((await quote(order, master.accessToken, 8000)).status).toBe(200);

    const stale = await decline(order, order.customerToken, 7000);
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe('ORDER_PRICE_STALE');
    expect((await priceRow(order.orderId)).status).toBe('MASTER_ARRIVED');

    const declined = await decline(order, order.customerToken, 8000);
    expect(declined.status).toBe(200);
    expect((declined.body as Order).status).toBe('CANCELLED');

    const row = await priceRow(order.orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.price_declined_at).not.toBeNull();
    // Its own class, never a late cancellation, however long after accept (ADR-0068 § 1).
    expect(row.cancellation_kind).toBe('price_declined');
    // The refused figure stays on the order, as a finished order's price does.
    expect(Number(row.price_minor)).toBe(8000);

    const { rows } = await pool.query<{
      actor_kind: string;
      actor_user_id: string;
      reason: string;
    }>(
      `select actor_kind, actor_user_id, reason from order_status_history
        where order_id = $1 and to_status = 'CANCELLED'`,
      [order.orderId],
    );
    expect(rows).toEqual([
      {
        actor_kind: 'customer',
        actor_user_id: order.customerUserId,
        reason: PRICE_DECLINED_REASON,
      },
    ]);

    // A second decline finds nothing to decline.
    expect((await decline(order, order.customerToken, 8000)).status).toBe(409);
  });

  it('clears the quote and its approval when the master sends the order back out', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);
    expect((await quote(order, master.accessToken, 6000)).status).toBe(200);
    expect((await approve(order, order.customerToken, 6000)).status).toBe(200);

    const redispatched = await transition(
      order,
      master.accessToken,
      'SEARCHING',
      'Lazımi hissə yoxdur.',
    );
    expect(redispatched.status).toBe(200);

    expect(await priceRow(order.orderId)).toMatchObject({
      status: 'SEARCHING',
      price_minor: null,
      price_approved_at: null,
    });
    // The trail keeps what was quoted and approved before the re-dispatch.
    expect(await priceEvents(order.orderId)).toHaveLength(2);
  });

  it('does not let an admin override start an unapproved inspection job', async () => {
    const master = await seedMaster();
    const order = await arrivedOrder(master, inspectionServiceId);

    const forced = await send(
      'post',
      `/admin/orders/${order.orderId}/transitions`,
      adminToken,
    ).send({ to: 'IN_PROGRESS', reason: 'Usta zəng etdi, başlamaq istəyir.' });
    expect(forced.status).toBe(409);
    expect(codeOf(forced)).toBe('ORDER_PRICE_NOT_APPROVED');
    expect((await priceRow(order.orderId)).status).toBe('MASTER_ARRIVED');
  });

  it('keeps the copied pricing shape fixed for the life of the order', async () => {
    const master = await seedMaster();
    const order = await acceptedOrder(master, inspectionServiceId);

    await expect(
      pool.query(`update orders set pricing_kind = 'fixed' where id = $1`, [order.orderId]),
    ).rejects.toThrow(/copied at creation/);
  });
});
