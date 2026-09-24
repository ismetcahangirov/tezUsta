import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  CurrentMasterJob,
  CursorPage,
  MasterOffer,
  OrderDetail,
  OrderStatus,
  Review,
} from '@tezusta/types';
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
 * Ratings in front of the counterpart, and the reviews a user has received
 * (issue #225, [ADR-0042](docs/decisions/ADR-0042-review-policy.md) § 6).
 *
 * Aggregates and reviews are written straight into the database: what is under
 * test is what each read exposes and to whom, not how the numbers got there
 * (that is `reviews.e2e.test.ts`).
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99450${String(phoneCounter).padStart(7, '0')}`;
}

interface Person {
  readonly userId: string;
  readonly token: string;
  readonly customerId?: string;
  readonly masterId?: string;
}

describe('ratings exposed to the counterpart (issue #225)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let adminId: string;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function get(path: string, token?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return token === undefined ? pending : pending.set('authorization', `Bearer ${token}`);
  }

  function post(path: string, token: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${token}`);
  }

  function required<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(`missing ${what}`);
    }
    return value;
  }

  async function person(roles: { customer?: boolean; master?: boolean }): Promise<Person> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    let customerId: string | undefined;
    let masterId: string | undefined;
    if (roles.customer === true) {
      const response = await post('/customers', pair.accessToken).send({ displayName: 'Aygün' });
      expect(response.status).toBe(201);
      customerId = (response.body as { id: string }).id;
    }
    if (roles.master === true) {
      const response = await post('/masters', pair.accessToken).send({ displayName: 'Rəşad' });
      expect(response.status).toBe(201);
      masterId = (response.body as { id: string }).id;
    }
    return {
      userId: created.user.id,
      token: pair.accessToken,
      ...(customerId === undefined ? {} : { customerId }),
      ...(masterId === undefined ? {} : { masterId }),
    };
  }

  async function setRating(
    table: 'masters' | 'customers',
    id: string,
    sum: number,
    count: number,
  ): Promise<void> {
    await pool.query(`update ${table} set rating_sum = $2, rating_count = $3 where id = $1`, [
      id,
      sum,
      count,
    ]);
  }

  async function seedOrder(
    customer: Person,
    master: Person | null,
    status: OrderStatus,
  ): Promise<string> {
    const address = await post('/addresses', customer.token).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);
    const orderId = randomUUID();
    await pool.query(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status,
                           description, idempotency_key, price_minor, accepted_at)
       values ($1, $2, $3, $4, $5, $6::order_status, 'Kran sızır.', $7, $8, $9)`,
      [
        orderId,
        required(customer.customerId, 'customer profile'),
        (address.body as { id: string }).id,
        serviceId,
        master?.masterId ?? null,
        status,
        randomUUID(),
        master === null ? null : 6700,
        master === null ? null : new Date(),
      ],
    );
    return orderId;
  }

  async function seedOffer(orderId: string, masterId: string, status: string): Promise<void> {
    await pool.query(
      `insert into order_offers (id, order_id, master_id, round, radius_m, distance_m, status,
                                 expires_at, responded_at)
       values ($1, $2, $3, 1, 3000, 1200, $4::order_offer_status, now() + interval '5 minutes', $5)`,
      [randomUUID(), orderId, masterId, status, status === 'offered' ? null : new Date()],
    );
  }

  async function seedReview(input: {
    orderId: string;
    customerId: string;
    masterId: string;
    authorRole: 'customer' | 'master';
    rating: number;
    revealedAt: Date | null;
    removed?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into reviews (id, order_id, customer_id, master_id, author_role, rating, comment,
                            revealed_at, removed_at, removed_by_admin_id, removal_reason)
       values ($1, $2, $3, $4, $5::review_author_role, $6, 'Şərh', $7, $8, $9, $10)`,
      [
        id,
        input.orderId,
        input.customerId,
        input.masterId,
        input.authorRole,
        input.rating,
        input.revealedAt,
        input.removed === true ? new Date() : null,
        input.removed === true ? adminId : null,
        input.removed === true ? 'Təhqir.' : null,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    serviceId = required(catalogue.rows[0]?.id, 'service');
    const admin = await pool.query<{ id: string }>(
      `insert into admin_users (id, email, display_name)
       values (gen_random_uuid(), 'ratings-admin@tezusta.az', 'Admin') returning id`,
    );
    adminId = required(admin.rows[0]?.id, 'admin');
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

  describe("the master's rating on the customer's order", () => {
    it('carries the assigned master’s average and count', async () => {
      const customer = await person({ customer: true });
      const master = await person({ master: true });
      await setRating('masters', required(master.masterId, 'master'), 14, 3);
      const orderId = await seedOrder(customer, master, 'MASTER_ON_THE_WAY');

      const response = await get(`/orders/${orderId}`, customer.token);
      expect(response.status).toBe(200);
      expect((response.body as OrderDetail).masterRating).toEqual({
        ratingAverage: 4.67,
        ratingCount: 3,
      });
    });

    it('has no average for a master nobody has rated yet', async () => {
      const customer = await person({ customer: true });
      const master = await person({ master: true });
      const orderId = await seedOrder(customer, master, 'ACCEPTED');

      const response = await get(`/orders/${orderId}`, customer.token);
      expect((response.body as OrderDetail).masterRating).toEqual({
        ratingAverage: null,
        ratingCount: 0,
      });
    });

    it('is null while no master is assigned', async () => {
      const customer = await person({ customer: true });
      const orderId = await seedOrder(customer, null, 'SEARCHING');

      const response = await get(`/orders/${orderId}`, customer.token);
      expect(response.status).toBe(200);
      expect((response.body as OrderDetail).masterRating).toBeNull();
    });

    it('is not on the order list', async () => {
      const customer = await person({ customer: true });
      const master = await person({ master: true });
      await seedOrder(customer, master, 'ACCEPTED');

      const response = await get('/orders', customer.token);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toMatch(/rating/i);
    });
  });

  describe("the customer's rating on the master's job", () => {
    it('carries the customer’s average and count on the current job', async () => {
      const customer = await person({ customer: true });
      const master = await person({ master: true });
      await setRating('customers', required(customer.customerId, 'customer'), 9, 2);
      const orderId = await seedOrder(customer, master, 'ACCEPTED');
      await seedOffer(orderId, required(master.masterId, 'master'), 'accepted');

      const response = await get('/masters/me/jobs/current', master.token);
      expect(response.status).toBe(200);
      const { job } = response.body as CurrentMasterJob;
      expect(job?.orderId).toBe(orderId);
      expect(job?.customerRating).toEqual({ ratingAverage: 4.5, ratingCount: 2 });
    });

    it('never puts a rating on a broadcast offer card', async () => {
      const customer = await person({ customer: true });
      const master = await person({ master: true });
      const masterId = required(master.masterId, 'master');
      await setRating('customers', required(customer.customerId, 'customer'), 5, 1);
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         values ($1, $2, 6700, true)`,
        [masterId, serviceId],
      );
      const orderId = await seedOrder(customer, null, 'SEARCHING');
      await seedOffer(orderId, masterId, 'offered');

      const response = await get('/masters/me/offers', master.token);
      expect(response.status).toBe(200);
      const offers = response.body as MasterOffer[];
      expect(offers.map((offer) => offer.id)).toHaveLength(1);
      expect(JSON.stringify(offers)).not.toMatch(/rating/i);
    });
  });

  describe('GET /me/reviews/received', () => {
    it('needs a token', async () => {
      expect((await get('/me/reviews/received?role=master')).status).toBe(401);
    });

    it.each([
      ['no role', ''],
      ['an unknown role', '?role=admin'],
      ['a zero limit', '?role=master&limit=0'],
      ['an unknown parameter', '?role=master&sort=asc'],
    ])('refuses %s', async (_label, query) => {
      const master = await person({ master: true });
      const response = await get(`/me/reviews/received${query}`, master.token);
      expect(response.status).toBe(422);
      expect((response.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for a role the caller has no profile in', async () => {
      const customerOnly = await person({ customer: true });
      expect((await get('/me/reviews/received?role=master', customerOnly.token)).status).toBe(404);
    });

    it('lists only revealed, unremoved reviews about the caller in that role, newest first', async () => {
      // One person who is both: a master to some, a customer to another.
      const both = await person({ customer: true, master: true });
      const bothMasterId = required(both.masterId, 'master');
      const bothCustomerId = required(both.customerId, 'customer');
      const now = Date.now();

      const reviewAbout = async (
        rating: number,
        revealedAt: Date | null,
        removed = false,
      ): Promise<string> => {
        const customer = await person({ customer: true });
        const orderId = await seedOrder(customer, both, 'COMPLETED');
        return seedReview({
          orderId,
          customerId: required(customer.customerId, 'customer'),
          masterId: bothMasterId,
          authorRole: 'customer',
          rating,
          revealedAt,
          removed,
        });
      };

      const older = await reviewAbout(3, new Date(now - 60_000));
      const newer = await reviewAbout(5, new Date(now - 1_000));
      await reviewAbout(1, null); // sealed
      await reviewAbout(2, new Date(now - 30_000), true); // removed

      // Written *by* them as a master about a customer, and about them as a customer.
      const otherMaster = await person({ master: true });
      const asCustomerOrder = await seedOrder(both, otherMaster, 'COMPLETED');
      const aboutThemAsCustomer = await seedReview({
        orderId: asCustomerOrder,
        customerId: bothCustomerId,
        masterId: required(otherMaster.masterId, 'master'),
        authorRole: 'master',
        rating: 4,
        revealedAt: new Date(now - 5_000),
      });
      const someCustomer = await person({ customer: true });
      const byThemOrder = await seedOrder(someCustomer, both, 'COMPLETED');
      await seedReview({
        orderId: byThemOrder,
        customerId: required(someCustomer.customerId, 'customer'),
        masterId: bothMasterId,
        authorRole: 'master',
        rating: 5,
        revealedAt: new Date(now - 2_000),
      });

      const asMaster = await get('/me/reviews/received?role=master', both.token);
      expect(asMaster.status).toBe(200);
      const masterPage = asMaster.body as CursorPage<Review>;
      expect(masterPage.items.map((review) => review.id)).toEqual([newer, older]);
      expect(masterPage.items.every((review) => review.authorRole === 'customer')).toBe(true);
      expect(masterPage.nextCursor).toBeNull();

      const asCustomer = await get('/me/reviews/received?role=customer', both.token);
      const customerPage = asCustomer.body as CursorPage<Review>;
      expect(customerPage.items.map((review) => review.id)).toEqual([aboutThemAsCustomer]);
    });

    it('pages with a cursor', async () => {
      const master = await person({ master: true });
      const masterId = required(master.masterId, 'master');
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const customer = await person({ customer: true });
        const orderId = await seedOrder(customer, master, 'COMPLETED');
        ids.push(
          await seedReview({
            orderId,
            customerId: required(customer.customerId, 'customer'),
            masterId,
            authorRole: 'customer',
            rating: 4,
            revealedAt: new Date(Date.now() - (3 - index) * 1_000),
          }),
        );
      }

      const first = (await get('/me/reviews/received?role=master&limit=2', master.token))
        .body as CursorPage<Review>;
      expect(first.items.map((review) => review.id)).toEqual([ids[2], ids[1]]);
      expect(first.nextCursor).not.toBeNull();

      const second = (
        await get(
          `/me/reviews/received?role=master&limit=2&cursor=${first.nextCursor ?? ''}`,
          master.token,
        )
      ).body as CursorPage<Review>;
      expect(second.items.map((review) => review.id)).toEqual([ids[0]]);
      expect(second.nextCursor).toBeNull();
    });
  });
});
