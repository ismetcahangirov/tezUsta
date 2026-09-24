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
 * `GET /orders` and `GET /orders/:id` over real HTTP (issue #82).
 *
 * What only this layer can prove: that a stranger's order id is
 * indistinguishable from one that never existed, that paging through a list
 * while a new order is being created neither skips nor repeats a row — the
 * failure offset pagination has and a keyset cursor does not — and that a
 * `DRAFT` never reaches a customer through either route.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99453${String(phoneCounter).padStart(7, '0')}`;
}

function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

interface OrderBody {
  readonly id: string;
  readonly status: string;
  readonly priceMinor: number | null;
  readonly description: string;
  readonly createdAt: string;
}

interface OrderPage {
  readonly items: readonly OrderBody[];
  readonly nextCursor: string | null;
}

describe('order reads over HTTP (issue #82)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
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

  interface Customer {
    readonly accessToken: string;
    readonly addressId: string;
    readonly customerId: string;
  }

  async function signIn(): Promise<string> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
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

    return {
      accessToken,
      addressId: (address.body as { id: string }).id,
      customerId: (profile.body as { id: string }).id,
    };
  }

  async function createOrder(customer: Customer, description = 'Kran sızır, su dayanmır.') {
    const res = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description,
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(201);
    return res.body as OrderBody;
  }

  /** A `DRAFT` written straight to the table — no endpoint produces a visible one. */
  async function insertDraft(customer: Customer): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, status, description, idempotency_key)
       values (gen_random_uuid(), $1, $2, $3, 'DRAFT', 'Yarımçıq qalmış cəhd.', $4)
       returning id`,
      [customer.customerId, customer.addressId, serviceId, randomUUID()],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('failed to insert the draft order');
    }
    return id;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '5000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '5000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 1`,
    );
    const seeded = rows[0]?.id;
    if (seeded === undefined) {
      throw new Error('the seed should have provided at least one active service');
    }
    serviceId = seeded;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('GET /orders/:id', () => {
    it('returns the caller’s own order', async () => {
      const customer = await signInAsCustomer();
      const created = await createOrder(customer);

      const res = await get(`/orders/${created.id}`, customer.accessToken);
      expect(res.status).toBe(200);
      // The read adds the caller's unread message count (issue #182) and the
      // assigned master's rating (#225); an order still searching has no
      // conversation and no master, so they are zero and null.
      expect(res.body).toEqual({ ...created, unreadMessageCount: 0, masterRating: null });
    });

    it('reports a searching order’s absent price as null rather than erroring', async () => {
      const customer = await signInAsCustomer();
      const created = await createOrder(customer);

      const res = await get(`/orders/${created.id}`, customer.accessToken);
      expect((res.body as OrderBody).status).toBe('SEARCHING');
      expect((res.body as OrderBody).priceMinor).toBeNull();
    });

    it('requires authentication', async () => {
      const res = await get(`/orders/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it('answers 404 for a caller with no customer profile', async () => {
      const accessToken = await signIn();
      const res = await get(`/orders/${randomUUID()}`, accessToken);
      expect(res.status).toBe(404);
    });

    /**
     * The two responses must be identical. Anything that distinguishes them
     * turns this route into a way to ask whether a given uuid is somebody's
     * order.
     */
    it('cannot tell a stranger’s order from one that never existed', async () => {
      const mine = await signInAsCustomer();
      const stranger = await signInAsCustomer();
      const theirs = await createOrder(stranger);

      const cross = await get(`/orders/${theirs.id}`, mine.accessToken);
      const nobodys = await get(`/orders/${randomUUID()}`, mine.accessToken);

      expect(cross.status).toBe(404);
      expect(nobodys.status).toBe(404);
      expect(envelopeWithoutRequestId(cross.body)).toEqual(envelopeWithoutRequestId(nobodys.body));
    });

    it('never returns a DRAFT', async () => {
      const customer = await signInAsCustomer();
      const draftId = await insertDraft(customer);

      const res = await get(`/orders/${draftId}`, customer.accessToken);
      expect(res.status).toBe(404);
    });

    it('refuses an id that is not a uuid', async () => {
      const customer = await signInAsCustomer();
      const res = await get('/orders/not-a-uuid', customer.accessToken);
      expect(res.status).toBe(422);
    });
  });

  describe('GET /orders', () => {
    it('returns only the caller’s orders, newest first', async () => {
      const mine = await signInAsCustomer();
      const stranger = await signInAsCustomer();
      await createOrder(stranger, 'Başqasının sifarişi.');

      const first = await createOrder(mine, 'Birinci sifariş.');
      const second = await createOrder(mine, 'İkinci sifariş.');

      const res = await get('/orders', mine.accessToken);
      expect(res.status).toBe(200);

      const page = res.body as OrderPage;
      expect(page.items.map((order) => order.id)).toEqual([second.id, first.id]);
      expect(page.nextCursor).toBeNull();
    });

    it('excludes a DRAFT from the listing', async () => {
      const customer = await signInAsCustomer();
      const draftId = await insertDraft(customer);
      await createOrder(customer);

      const page = (await get('/orders', customer.accessToken)).body as OrderPage;
      expect(page.items.map((order) => order.id)).not.toContain(draftId);
    });

    /**
     * Five orders, two at a time. Every id must be visited exactly once — the
     * property offset pagination loses and a keyset cursor keeps.
     */
    it('walks every order exactly once, with no gaps and no repeats', async () => {
      const customer = await signInAsCustomer();
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push((await createOrder(customer, `Sifariş nömrə ${index + 1}.`)).id);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const path: string =
          cursor === null ? '/orders?limit=2' : `/orders?limit=2&cursor=${cursor}`;
        const res = await get(path, customer.accessToken);
        expect(res.status).toBe(200);

        const page = res.body as OrderPage;
        seen.push(...page.items.map((order) => order.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor !== null);

      expect(seen).toHaveLength(created.length);
      expect(new Set(seen).size).toBe(created.length);
      expect([...seen].sort()).toEqual([...created].sort());
    });

    /**
     * A row created **between** two page reads. Because the list is newest
     * first and the cursor names a position rather than a count, the new order
     * belongs above the window and must not shift what the second page shows.
     */
    it('does not let an order created mid-pagination disturb the window', async () => {
      const customer = await signInAsCustomer();
      const older: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        older.push((await createOrder(customer, `Köhnə sifariş ${index + 1}.`)).id);
      }

      const firstPage = (await get('/orders?limit=2', customer.accessToken)).body as OrderPage;
      expect(firstPage.nextCursor).not.toBeNull();

      await createOrder(customer, 'Səhifələmənin ortasında yaradılan sifariş.');

      const secondPage = (
        await get(`/orders?limit=2&cursor=${firstPage.nextCursor ?? ''}`, customer.accessToken)
      ).body as OrderPage;

      const seen = [...firstPage.items, ...secondPage.items].map((order) => order.id);
      expect(new Set(seen).size).toBe(seen.length);
      // The two pages together are the four orders that existed when paging
      // began — the newcomer is above the window, not inside it.
      expect([...seen].sort()).toEqual([...older].sort());
    });

    it('filters by status', async () => {
      const customer = await signInAsCustomer();
      const searching = await createOrder(customer);
      const cancelled = await createOrder(customer);
      await pool.query(`update orders set status = 'CANCELLED' where id = $1`, [cancelled.id]);

      const page = (await get('/orders?status=CANCELLED', customer.accessToken)).body as OrderPage;
      expect(page.items.map((order) => order.id)).toEqual([cancelled.id]);

      const other = (await get('/orders?status=SEARCHING', customer.accessToken)).body as OrderPage;
      expect(other.items.map((order) => order.id)).toContain(searching.id);
    });

    it('treats a malformed cursor as the beginning rather than as an error', async () => {
      const customer = await signInAsCustomer();
      const created = await createOrder(customer);

      const res = await get('/orders?cursor=not-a-real-cursor', customer.accessToken);
      expect(res.status).toBe(200);
      expect((res.body as OrderPage).items.map((order) => order.id)).toContain(created.id);
    });

    it('refuses a limit outside the allowed range, and an unknown query parameter', async () => {
      const customer = await signInAsCustomer();
      for (const query of ['?limit=0', '?limit=51', '?limit=abc', '?state=SEARCHING']) {
        const res = await get(`/orders${query}`, customer.accessToken);
        expect(res.status).toBe(422);
      }
    });

    it('refuses DRAFT as a status filter, since a customer never has one', async () => {
      const customer = await signInAsCustomer();
      const res = await get('/orders?status=DRAFT', customer.accessToken);
      expect(res.status).toBe(422);
    });

    it('requires authentication', async () => {
      const res = await get('/orders');
      expect(res.status).toBe(401);
    });
  });
});
