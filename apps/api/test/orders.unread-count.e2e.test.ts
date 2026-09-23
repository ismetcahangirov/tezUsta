import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { CursorPage, Message, OrderSummary } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The customer's unread message count on their own order reads (issue #182).
 *
 * `GET /orders` and `GET /orders/:id` carry `unreadMessageCount` so the order
 * list can badge every row **without a conversation request per row**
 * (CLAUDE.md §12). What only this layer can prove is that the number is the
 * one `GET /orders/:id/conversation` would have given for the same order —
 * the master's unread messages in the order's *open* conversation — and that
 * one page of several orders gets each order's own number.
 *
 * Orders are accepted by a real master through the live dispatch engine, the
 * way `order-conversation.e2e.test.ts` does it, because a conversation is only
 * ever opened inside the accept transaction.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99459${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

interface SeededCustomer {
  readonly accessToken: string;
  readonly addressId: string;
}

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
      throw new Error(`Condition still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the unread message count on the customer’s order reads (issue #182)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let serviceId: string;

  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${accessToken}`);
  }

  function get(path: string, accessToken: string) {
    return request(app.getHttpServer()).get(path).set('authorization', `Bearer ${accessToken}`);
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
       values ($1, $2, 6700, true)`,
      [masterId, serviceId],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2,
         ST_Project(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 400, radians(90))::geometry,
         now())`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, accessToken };
  }

  async function seedCustomer(): Promise<SeededCustomer> {
    const accessToken = await signIn();
    expect((await post('/customers', accessToken).send({ displayName: 'Müştəri' })).status).toBe(
      201,
    );
    const address = await post('/addresses', accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    return { accessToken, addressId: (address.body as { id: string }).id };
  }

  async function placeOrder(customer: SeededCustomer): Promise<string> {
    const order = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description: 'Mətbəxdə kran sızır.',
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    return (order.body as { id: string }).id;
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offer = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers
            where order_id = $1 and master_id = $2`,
          [orderId, master.masterId],
        );
        return rows[0];
      },
      (value) => value !== undefined && value.status === 'offered',
    );
    if (offer === undefined) {
      throw new Error('unreachable: the poll only returns a defined row');
    }
    const accepted = await post(`/masters/me/offers/${offer.id}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
  }

  async function send(orderId: string, token: string, body: string): Promise<Message> {
    const response = await post(`/orders/${orderId}/messages`, token).send({ body });
    expect(response.status).toBe(201);
    return response.body as Message;
  }

  async function listed(customer: SeededCustomer): Promise<Map<string, number>> {
    const response = await get('/orders', customer.accessToken);
    expect(response.status).toBe(200);
    const page = response.body as CursorPage<OrderSummary>;
    return new Map(page.items.map((order) => [order.id, order.unreadMessageCount]));
  }

  async function detail(customer: SeededCustomer, orderId: string): Promise<number> {
    const response = await get(`/orders/${orderId}`, customer.accessToken);
    expect(response.status).toBe(200);
    return (response.body as OrderSummary).unreadMessageCount;
  }

  async function conversationCount(customer: SeededCustomer, orderId: string): Promise<number> {
    const response = await get(`/orders/${orderId}/conversation`, customer.accessToken);
    expect(response.status).toBe(200);
    return (response.body as { unreadCount: number }).unreadCount;
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

    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', '3');

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
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  beforeEach(async () => {
    // A master left available by a finished test would crowd the next test's
    // broadcast — the fixture hazard `order-redispatch.e2e.test.ts` documents.
    if (seededMasterIds.length === 0) {
      return;
    }
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

  it('is zero for an order that has no conversation yet', async () => {
    const customer = await seedCustomer();
    const orderId = await placeOrder(customer);

    expect((await listed(customer)).get(orderId)).toBe(0);
    expect(await detail(customer, orderId)).toBe(0);
  });

  it('counts the master’s unread messages and not the customer’s own', async () => {
    const customer = await seedCustomer();
    const master = await seedMaster();
    const orderId = await placeOrder(customer);
    await accept(orderId, master);

    await send(orderId, master.accessToken, 'Salam, yoldayam.');
    await send(orderId, customer.accessToken, 'Gözləyirəm.');
    await send(orderId, master.accessToken, 'On dəqiqəyə çatıram.');

    expect((await listed(customer)).get(orderId)).toBe(2);
    expect(await detail(customer, orderId)).toBe(2);
    // The same number the conversation itself reports — two reads of one fact.
    expect(await conversationCount(customer, orderId)).toBe(2);
  });

  it('falls as the customer reads, and reaches zero when everything is read', async () => {
    const customer = await seedCustomer();
    const master = await seedMaster();
    const orderId = await placeOrder(customer);
    await accept(orderId, master);

    const first = await send(orderId, master.accessToken, 'Birinci.');
    await send(orderId, master.accessToken, 'İkinci.');
    const third = await send(orderId, master.accessToken, 'Üçüncü.');
    expect(await detail(customer, orderId)).toBe(3);

    const partly = await post(`/orders/${orderId}/messages/read`, customer.accessToken).send({
      throughMessageId: first.id,
    });
    expect(partly.status).toBe(200);
    expect(await detail(customer, orderId)).toBe(2);
    expect((await listed(customer)).get(orderId)).toBe(2);

    const fully = await post(`/orders/${orderId}/messages/read`, customer.accessToken).send({
      throughMessageId: third.id,
    });
    expect(fully.status).toBe(200);
    expect(await detail(customer, orderId)).toBe(0);
    expect((await listed(customer)).get(orderId)).toBe(0);
  });

  /**
   * The batched read's reason to exist: one page, several orders, and each row
   * gets its own number rather than a total or its neighbour's.
   */
  it('gives every order on one page its own count', async () => {
    const customer = await seedCustomer();

    const firstMaster = await seedMaster();
    const busy = await placeOrder(customer);
    await accept(busy, firstMaster);

    // The first master is now engaged and out of the next broadcast.
    const secondMaster = await seedMaster();
    const quiet = await placeOrder(customer);
    await accept(quiet, secondMaster);

    const searching = await placeOrder(customer);

    await send(busy, firstMaster.accessToken, 'Bir.');
    await send(busy, firstMaster.accessToken, 'İki.');
    await send(quiet, secondMaster.accessToken, 'Salam.');

    const counts = await listed(customer);
    expect(counts.get(busy)).toBe(2);
    expect(counts.get(quiet)).toBe(1);
    expect(counts.get(searching)).toBe(0);
  });

  /**
   * A re-dispatch closes the conversation (ADR-0033 § 2) and the customer can
   * no longer open it, so its unread tail must not keep a badge alight on an
   * order that is searching again.
   */
  it('does not count a closed conversation after the order is sent back out', async () => {
    const customer = await seedCustomer();
    const master = await seedMaster();
    const orderId = await placeOrder(customer);
    await accept(orderId, master);

    await send(orderId, master.accessToken, 'Bağışlayın, gələ bilməyəcəm.');
    expect(await detail(customer, orderId)).toBe(1);

    const redispatched = await post(`/orders/${orderId}/transitions`, master.accessToken).send({
      to: 'SEARCHING',
      reason: 'Maşınım xarab oldu.',
    });
    expect(redispatched.status).toBe(200);

    expect(await detail(customer, orderId)).toBe(0);
    expect((await listed(customer)).get(orderId)).toBe(0);
  });

  it('is never another customer’s number', async () => {
    const owner = await seedCustomer();
    const stranger = await seedCustomer();
    const master = await seedMaster();
    const orderId = await placeOrder(owner);
    await accept(orderId, master);
    await send(orderId, master.accessToken, 'Salam.');

    expect((await get(`/orders/${orderId}`, stranger.accessToken)).status).toBe(404);
    expect((await listed(stranger)).has(orderId)).toBe(false);
  });
});
