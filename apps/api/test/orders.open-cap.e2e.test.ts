import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `MAX_OPEN_ORDERS_PER_CUSTOMER` over real HTTP and a real Postgres (issue
 * #273).
 *
 * The cap is set to three here explicitly: `setup-env.ts` raises it for every
 * other suite, because they are about something else. What only this layer can
 * prove is the concurrent case — N creates in flight at once, each with its
 * own idempotency key, must produce exactly the cap and not one more. A
 * count-then-insert with no serialisation passes every sequential test in this
 * file and fails that one.
 */

const CAP = 3;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99452${String(phoneCounter).padStart(7, '0')}`;
}

interface OrderBody {
  readonly id: string;
  readonly status: string;
}

describe('the open-order cap per customer (issue #273)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let serviceId: string;
  const originals = new Map<string, string | undefined>();

  interface Customer {
    readonly accessToken: string;
    readonly addressId: string;
    readonly customerId: string;
  }

  function set(name: string, value: string): void {
    if (!originals.has(name)) {
      originals.set(name, process.env[name]);
    }
    process.env[name] = value;
  }

  function post(path: string, accessToken: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${accessToken}`);
  }

  async function signInAsCustomer(): Promise<Customer> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const { accessToken } = await sessionsService.startSession({ userId: created.user.id });

    const profile = await post('/customers', accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);

    return {
      accessToken,
      addressId: (address.body as { id: string }).id,
      customerId: (profile.body as { id: string }).id,
    };
  }

  function create(customer: Customer, idempotencyKey: string = randomUUID()) {
    return post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description: DESCRIPTION,
      idempotencyKey,
    });
  }

  async function fillToCap(customer: Customer): Promise<OrderBody[]> {
    const orders: OrderBody[] = [];
    for (let i = 0; i < CAP; i += 1) {
      const res = await create(customer);
      expect(res.status).toBe(201);
      orders.push(res.body as OrderBody);
    }
    return orders;
  }

  function expectCapRefusal(res: request.Response): void {
    expect(res.status).toBe(409);
    expect((res.body as ErrorEnvelope).error.code).toBe('OPEN_ORDER_LIMIT_EXCEEDED');
  }

  async function ordersOf(customer: Customer): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*) as count from orders where customer_id = $1',
      [customer.customerId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('MAX_OPEN_ORDERS_PER_CUSTOMER', String(CAP));
    // The cap is the subject here; the hourly budget is not.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '5000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '5000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '5000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '5000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active and pricing_kind = 'fixed' order by id limit 1`,
    );
    const seeded = rows[0]?.id;
    if (seeded === undefined) {
      throw new Error('the seed should have provided at least one active fixed-price service');
    }
    serviceId = seeded;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    for (const [name, value] of originals) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  it('refuses the (cap + 1)th open order with a stable code, and creates nothing', async () => {
    const customer = await signInAsCustomer();
    await fillToCap(customer);

    const refused = await create(customer);

    expectCapRefusal(refused);
    expect(await ordersOf(customer)).toBe(CAP);
  });

  it('counts only the caller: another customer is unaffected by a full one', async () => {
    const full = await signInAsCustomer();
    await fillToCap(full);
    const other = await signInAsCustomer();

    const res = await create(other);

    expect(res.status).toBe(201);
  });

  it('still returns an already-created order on a retry of its key at the cap', async () => {
    const customer = await signInAsCustomer();
    const key = randomUUID();
    const first = await create(customer, key);
    expect(first.status).toBe(201);
    for (let i = 1; i < CAP; i += 1) {
      expect((await create(customer)).status).toBe(201);
    }

    const retry = await create(customer, key);

    expect(retry.status).toBe(201);
    expect((retry.body as OrderBody).id).toBe((first.body as OrderBody).id);
    expect(await ordersOf(customer)).toBe(CAP);
  });

  it('frees a slot when the customer cancels an order', async () => {
    const customer = await signInAsCustomer();
    const [first] = await fillToCap(customer);
    expectCapRefusal(await create(customer));

    const cancelled = await post(
      `/orders/${first?.id ?? ''}/transitions`,
      customer.accessToken,
    ).send({ to: 'CANCELLED', reason: 'Artıq lazım deyil.' });
    expect(cancelled.status).toBe(200);

    expect((await create(customer)).status).toBe(201);
  });

  it('counts an engaged order as open, and frees its slot once it completes', async () => {
    const customer = await signInAsCustomer();
    const [first] = await fillToCap(customer);
    // Driving a real master through accept is `order-transitions.e2e`'s job;
    // here the only thing under test is which statuses the count includes.
    await pool.query(`update orders set status = 'IN_PROGRESS' where id = $1`, [first?.id]);
    expectCapRefusal(await create(customer));

    await pool.query(`update orders set status = 'COMPLETED' where id = $1`, [first?.id]);

    expect((await create(customer)).status).toBe(201);
  });

  it('does not count an order the search gave up on', async () => {
    const customer = await signInAsCustomer();
    const [first] = await fillToCap(customer);

    await pool.query(`update orders set status = 'NO_MASTER_FOUND' where id = $1`, [first?.id]);

    expect((await create(customer)).status).toBe(201);
  });

  /**
   * The acceptance criterion the rest of this file cannot reach. Every request
   * carries its own key, so idempotency does not collapse any of them; only
   * serialisation per customer keeps the count and the insert together.
   */
  it('lets exactly the cap through when many creates arrive at once', async () => {
    const customer = await signInAsCustomer();
    const attempts = 8;

    const responses = await Promise.all(Array.from({ length: attempts }, () => create(customer)));

    const created = responses.filter((res) => res.status === 201);
    const refused = responses.filter((res) => res.status === 409);
    expect(created).toHaveLength(CAP);
    expect(refused).toHaveLength(attempts - CAP);
    for (const res of refused) {
      expectCapRefusal(res);
    }
    expect(await ordersOf(customer)).toBe(CAP);
  }, 30_000);

  it('answers the count from the (customer_id, status) index', async () => {
    const customer = await signInAsCustomer();
    await fillToCap(customer);

    // A test database this small makes a sequential scan the honest choice, so
    // it is ruled out for the one statement whose index is being asserted.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': unknown[] }>(
        `explain (format json)
           select count(*) from orders
            where customer_id = $1
              and status in ('SEARCHING','ACCEPTED','MASTER_ON_THE_WAY','MASTER_ARRIVED','IN_PROGRESS')`,
        [customer.customerId],
      );
      await client.query('rollback');

      const plan = JSON.stringify(rows[0]?.['QUERY PLAN']);
      expect(plan).toContain('orders_customer_status_idx');
      expect(plan).not.toContain('Seq Scan');
    } finally {
      client.release();
    }
  });
});
