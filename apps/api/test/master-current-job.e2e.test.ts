import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { CurrentMasterJob } from '@tezusta/types';
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
 * `GET /masters/me/jobs/current` over real HTTP (issue #198).
 *
 * **The tests that matter are the ways out.** A read that returns the job is
 * easy; the security surface is that the job — and the customer's home address
 * it carries — stops being returned the instant the order stops being this
 * master's: a re-dispatch, a customer cancellation, a completion. Each gets its
 * own test, because each leaves a different row behind: a re-dispatched
 * master still holds an `accepted` offer, and a read that started from the
 * offer would hand the address straight back.
 *
 * The accept goes through the **real** accept path, as in
 * `order-transitions.e2e.test.ts`, so the offer id and the frozen price are
 * whatever production would have produced.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const MASTER_PRICE_MINOR = 6700;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';
const FORMATTED_ADDRESS = 'Nizami küçəsi 203';
const REASON = 'Maşın xarab oldu.';

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly addressId: string;
  readonly offerId: string;
  readonly customerToken: string;
}

describe('the master reads the job they are on (issue #198)', () => {
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

  function post(path: string, accessToken: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${accessToken}`);
  }

  function current(accessToken?: string) {
    const pending = request(app.getHttpServer()).get('/masters/me/jobs/current');
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<string> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return pair.accessToken;
  }

  async function seedMaster(): Promise<SeededMaster> {
    const accessToken = await signIn();
    const created = await post('/masters', accessToken).send({ displayName: 'Usta Anar' });
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

    return { masterId, accessToken };
  }

  async function acceptedOrder(master: SeededMaster): Promise<SeededOrder> {
    const customerToken = await signIn();
    const profile = await post('/customers', customerToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', customerToken).send({
      formattedAddress: FORMATTED_ADDRESS,
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    const addressId = (address.body as { id: string }).id;

    const order = await post('/orders', customerToken).send({
      serviceId,
      addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    const orderId = (order.body as { id: string }).id;

    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );

    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);

    return { orderId, addressId, offerId, customerToken };
  }

  function transition(orderId: string, token: string, to: string, reason?: string) {
    return post(`/orders/${orderId}/transitions`, token).send(
      reason === undefined ? { to } : { to, reason },
    );
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
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_IP_HOUR', '9000');

    // The live engine reaches nobody, for `order-transitions.e2e.test.ts`'s
    // reason: this suite writes its own offer row, and a broadcast into the
    // same table would collide on `order_offers_order_master_unique`.
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

  describe('who may ask', () => {
    it('refuses a request with no token', async () => {
      const response = await current();

      expect(response.status).toBe(401);
    });

    it('refuses a caller who is not a master', async () => {
      const customerToken = await signIn();
      await post('/customers', customerToken).send({ displayName: 'Müştəri' });

      const response = await current(customerToken);

      expect(response.status).toBe(403);
      expect((response.body as ErrorEnvelope).error.code).toBeDefined();
    });
  });

  describe('the job', () => {
    it('answers null for a master with no job', async () => {
      const master = await seedMaster();

      const response = await current(master.accessToken);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ job: null });
    });

    it('returns the accepted order with its address, its offer and its frozen price', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await current(master.accessToken);

      expect(response.status).toBe(200);
      const { job } = response.body as CurrentMasterJob;
      expect(job).toMatchObject({
        orderId: order.orderId,
        offerId: order.offerId,
        status: 'ACCEPTED',
        serviceId,
        description: DESCRIPTION,
        priceMinor: MASTER_PRICE_MINOR,
      });
      expect(job?.address.id).toBe(order.addressId);
      expect(job?.address.formattedAddress).toBe(FORMATTED_ADDRESS);
      expect(job?.address.latitude).toBeCloseTo(SEARCH_POINT.latitude, 5);
    });

    it('carries nothing that identifies the customer beyond the address', async () => {
      const master = await seedMaster();
      await acceptedOrder(master);

      const response = await current(master.accessToken);
      const job = (response.body as CurrentMasterJob).job as unknown as Record<string, unknown>;

      expect(Object.keys(job).sort()).toEqual(
        [
          'acceptedAt',
          'address',
          'description',
          'offerId',
          'orderId',
          'priceMinor',
          'serviceId',
          'status',
        ].sort(),
      );
      expect(JSON.stringify(response.body)).not.toContain('customerId');
    });

    it('follows the order as the master advances it', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'] as const) {
        expect((await transition(order.orderId, master.accessToken, to)).status).toBe(200);

        const response = await current(master.accessToken);
        expect((response.body as CurrentMasterJob).job?.status).toBe(to);
      }
    });

    it('is not visible to a different master', async () => {
      const master = await seedMaster();
      await acceptedOrder(master);
      const stranger = await seedMaster();

      const response = await current(stranger.accessToken);

      expect(response.body).toEqual({ job: null });
    });
  });

  describe('the ways out, each of which takes the address back', () => {
    it('answers null once the job is completed', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
        expect((await transition(order.orderId, master.accessToken, to)).status).toBe(200);
      }

      const response = await current(master.accessToken);

      expect(response.body).toEqual({ job: null });
    });

    it('answers null once the customer cancels', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      expect(
        (await transition(order.orderId, order.customerToken, 'CANCELLED', REASON)).status,
      ).toBe(200);

      const response = await current(master.accessToken);

      expect(response.body).toEqual({ job: null });
    });

    it('answers null once the master sends the order back out, though their offer still reads accepted', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      expect(
        (await transition(order.orderId, master.accessToken, 'SEARCHING', REASON)).status,
      ).toBe(200);

      const { rows } = await pool.query<{ status: string }>(
        'select status from order_offers where id = $1',
        [order.offerId],
      );
      expect(rows[0]?.status).toBe('accepted');

      const response = await current(master.accessToken);

      expect(response.body).toEqual({ job: null });
    });
  });

  it('answers from the engaged-order index, not a scan', async () => {
    const master = await seedMaster();
    await acceptedOrder(master);

    const { rows } = await pool.query<{ 'QUERY PLAN': unknown[] }>(
      `explain (format json)
         select o.id, oo.id
           from orders o
           join order_offers oo on oo.order_id = o.id and oo.master_id = o.master_id
          where o.master_id = $1
            and o.status in ('ACCEPTED','MASTER_ON_THE_WAY','MASTER_ARRIVED','IN_PROGRESS')
          limit 1`,
      [master.masterId],
    );

    const plan = JSON.stringify(rows[0]?.['QUERY PLAN']);
    expect(plan).toContain('orders_one_active_per_master');
    expect(plan).not.toContain('Seq Scan');
  });
});
