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
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `POST /orders` over real HTTP, through the real `AppModule` graph (issue #81).
 *
 * What only this layer can prove: that the route sits behind authentication,
 * that a customer cannot place an order against a stranger's address without
 * learning whether that address exists, and — the one that matters most — that
 * idempotency holds when two requests are genuinely **in flight at the same
 * time** rather than merely one after the other. A sequential retry passes
 * against a read-then-write implementation; a concurrent one does not.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

interface OrderBody {
  readonly id: string;
  readonly status: string;
  readonly serviceId: string;
  readonly addressId: string;
  readonly description: string;
  readonly priceMinor: number | null;
  readonly masterId: string | null;
  readonly redispatchCount: number;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

describe('order creation over HTTP (issue #81)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalPerUser: string | undefined;
  let originalPerIp: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let serviceId: string;

  interface Customer {
    readonly userId: string;
    readonly accessToken: string;
    readonly addressId: string;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<string> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return pair.accessToken;
  }

  async function signInAsCustomer(): Promise<Customer> {
    const accessToken = await signIn();
    const profile = await post('/customers', accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);

    const { id: addressId } = address.body as { id: string };
    return { userId: (profile.body as { id: string }).id, accessToken, addressId };
  }

  function payload(customer: Customer, overrides: Record<string, unknown> = {}) {
    return {
      serviceId,
      addressId: customer.addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  async function orderCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>('select count(*) as count from orders');
    return Number(rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    // No `RATE_LIMIT_KEY_SECRET` of this file's own any more: `setup-env.ts`
    // generates one per test file (issue #108), so the twenty-odd orders
    // created below already cannot spend a budget
    // `orders.rate-limit.e2e.test.ts` is trying to measure.

    // This suite is about creation, not about the budget. The limit has its
    // own file, where the number is the subject rather than the obstacle.
    originalPerUser = process.env.ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR;
    originalPerIp = process.env.ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR;
    process.env.ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR = '5000';
    process.env.ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR = '5000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
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
    restore('DATABASE_URL', originalDatabaseUrl);
    restore('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', originalPerUser);
    restore('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', originalPerIp);
    await database.drop();
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  describe('the happy path', () => {
    it('creates one order, searching, with no price and no master', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(payload(customer));

      expect(res.status).toBe(201);
      const order = res.body as OrderBody;
      expect(order).toMatchObject({
        status: 'SEARCHING',
        serviceId,
        addressId: customer.addressId,
        description: DESCRIPTION,
        priceMinor: null,
        masterId: null,
        redispatchCount: 0,
        acceptedAt: null,
      });
    });

    it('never answers with a DRAFT, which is an internal anchor', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(payload(customer));
      expect((res.body as OrderBody).status).not.toBe('DRAFT');
    });

    it('writes the DRAFT → SEARCHING transition to the audit trail', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(payload(customer));
      const { id } = res.body as OrderBody;

      const { rows } = await pool.query<{
        from_status: string;
        to_status: string;
        actor_kind: string;
        actor_user_id: string | null;
      }>(
        `select from_status, to_status, actor_kind, actor_user_id
           from order_status_history where order_id = $1`,
        [id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from_status: 'DRAFT',
        to_status: 'SEARCHING',
        actor_kind: 'system',
        actor_user_id: null,
      });
    });
  });

  describe('idempotency', () => {
    it('returns the same order, twice, for the same key', async () => {
      const customer = await signInAsCustomer();
      const body = payload(customer);

      const first = await post('/orders', customer.accessToken).send(body);
      const before = await orderCount();
      const second = await post('/orders', customer.accessToken).send(body);
      const after = await orderCount();

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(after).toBe(before);
    });

    /**
     * The sequential retry above passes against a read-then-write
     * implementation too. This one does not: both requests are in flight
     * before either commits, which is the shape a phone on a flaky connection
     * actually produces.
     */
    it('creates exactly one order when two identical requests race', async () => {
      const customer = await signInAsCustomer();
      const body = payload(customer);

      const [first, second] = await Promise.all([
        post('/orders', customer.accessToken).send(body),
        post('/orders', customer.accessToken).send(body),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((first.body as OrderBody).id).toBe((second.body as OrderBody).id);

      const { rows } = await pool.query<{ count: string }>(
        'select count(*) as count from orders where idempotency_key = $1',
        [body.idempotencyKey],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('refuses a key that is being reused for a different order', async () => {
      const customer = await signInAsCustomer();
      const body = payload(customer);

      expect((await post('/orders', customer.accessToken).send(body)).status).toBe(201);

      const res = await post('/orders', customer.accessToken).send({
        ...body,
        description: 'Tamamilə başqa bir problem — qapı açılmır.',
      });
      expect(res.status).toBe(409);
    });

    it('lets two different customers use the same key', async () => {
      const first = await signInAsCustomer();
      const second = await signInAsCustomer();
      const key = randomUUID();

      const a = await post('/orders', first.accessToken).send(
        payload(first, { idempotencyKey: key }),
      );
      const b = await post('/orders', second.accessToken).send(
        payload(second, { idempotencyKey: key }),
      );

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((a.body as OrderBody).id).not.toBe((b.body as OrderBody).id);
    });
  });

  describe('what the caller is not allowed to name', () => {
    it('requires authentication', async () => {
      const res = await post('/orders').send({
        serviceId,
        addressId: randomUUID(),
        description: DESCRIPTION,
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(401);
    });

    it('answers 404 for a caller with no customer profile', async () => {
      const accessToken = await signIn();
      const res = await post('/orders', accessToken).send({
        serviceId,
        addressId: randomUUID(),
        description: DESCRIPTION,
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(404);
    });

    /**
     * The same 404, byte for byte, as an address that does not exist at all.
     * A 403 — or any distinguishable response — would turn this endpoint into
     * a way to ask whether a given address id belongs to somebody.
     */
    it('cannot tell a stranger’s address from one that never existed', async () => {
      const mine = await signInAsCustomer();
      const stranger = await signInAsCustomer();

      const theirs = await post('/orders', mine.accessToken).send(
        payload(mine, { addressId: stranger.addressId }),
      );
      const nobodys = await post('/orders', mine.accessToken).send(
        payload(mine, { addressId: randomUUID() }),
      );

      expect(theirs.status).toBe(404);
      expect(nobodys.status).toBe(404);
      expect(envelopeWithoutRequestId(theirs.body)).toEqual(envelopeWithoutRequestId(nobodys.body));
    });

    it('refuses an unknown service', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { serviceId: randomUUID() }),
      );
      expect(res.status).toBe(404);
    });

    it('refuses a service that is no longer offered', async () => {
      const customer = await signInAsCustomer();
      const { rows } = await pool.query<{ id: string }>(
        `select id from services where is_active order by id desc limit 1`,
      );
      const retired = rows[0]?.id;
      if (retired === undefined) {
        throw new Error('expected a seeded service to retire');
      }
      await pool.query('update services set is_active = false where id = $1', [retired]);

      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { serviceId: retired }),
      );
      expect(res.status).toBe(404);

      await pool.query('update services set is_active = true where id = $1', [retired]);
    });

    /**
     * `priceMinor`, `status` and `masterId` are all columns on the row this
     * request creates, and all three are the server's. `.strict()` refusing
     * them is the mass-assignment guard, and a silently dropped field would
     * leave the client believing it had set a price.
     */
    it('refuses a body that tries to set the price, the status or the master', async () => {
      const customer = await signInAsCustomer();
      for (const smuggled of [
        { priceMinor: 1 },
        { status: 'ACCEPTED' },
        { masterId: randomUUID() },
      ]) {
        const res = await post('/orders', customer.accessToken).send(payload(customer, smuggled));
        expect(res.status).toBe(422);
      }
    });
  });

  describe('validation', () => {
    it('refuses a description too short to act on, with the field named', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { description: 'su' }),
      );

      expect(res.status).toBe(422);
      const { error } = res.body as ErrorEnvelope;
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(error.details)).toContain('description');
    });

    it('refuses a description past the cap', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { description: 'ə'.repeat(2001) }),
      );
      expect(res.status).toBe(422);
    });

    it('refuses a missing or empty idempotency key', async () => {
      const customer = await signInAsCustomer();
      for (const key of ['', '   ']) {
        const res = await post('/orders', customer.accessToken).send(
          payload(customer, { idempotencyKey: key }),
        );
        expect(res.status).toBe(422);
      }
    });

    it('refuses an idempotency key past the cap', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { idempotencyKey: 'k'.repeat(129) }),
      );
      expect(res.status).toBe(422);
    });

    it('refuses a service id that is not a uuid', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send(
        payload(customer, { serviceId: 'not-a-uuid' }),
      );
      expect(res.status).toBe(422);
    });
  });
});
