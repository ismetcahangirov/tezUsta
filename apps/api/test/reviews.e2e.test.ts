import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderReviews, OrderStatus, Review } from '@tezusta/types';
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
 * Submitting, editing and reading reviews over real HTTP against real Postgres
 * (issue #222, [ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **Completed orders are written straight into the database**, with their
 * `COMPLETED` trail row, rather than driven there through dispatch and four
 * transitions. What is under test starts at completion, and the window rule
 * needs completions that happened a precise number of hours ago — which no
 * API can produce. The parties are real, created through the same endpoints
 * the app uses, so authorization is exercised against real profiles.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

/** ADR-0042 § 9 — the real default, so the limit test proves the shipped number. */
const REVIEW_BUDGET = 10;

interface Party {
  readonly userId: string;
  readonly token: string;
  /** The customer or master profile id. */
  readonly profileId: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customer: Party;
  readonly master: Party;
}

describe('reviews on an order (issue #222)', () => {
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

  function http(method: 'get' | 'post' | 'put', path: string, token?: string) {
    const pending = request(app.getHttpServer())[method](path);
    return token === undefined ? pending : pending.set('authorization', `Bearer ${token}`);
  }

  function submit(orderId: string, token: string, body: object) {
    return http('post', `/orders/${orderId}/review`, token).send(body);
  }

  function edit(orderId: string, token: string, body: object) {
    return http('put', `/orders/${orderId}/review`, token).send(body);
  }

  async function read(orderId: string, token: string): Promise<OrderReviews> {
    const response = await http('get', `/orders/${orderId}/reviews`, token);
    expect(response.status).toBe(200);
    return response.body as OrderReviews;
  }

  function errorCode(response: { body: unknown }): string {
    return (response.body as ErrorEnvelope).error.code;
  }

  async function signIn(): Promise<{ userId: string; token: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, token: pair.accessToken };
  }

  async function seedCustomer(): Promise<Party> {
    const caller = await signIn();
    const created = await http('post', '/customers', caller.token).send({
      displayName: 'Müştəri',
    });
    expect(created.status).toBe(201);
    return { ...caller, profileId: (created.body as { id: string }).id };
  }

  async function seedMaster(): Promise<Party> {
    const caller = await signIn();
    const created = await http('post', '/masters', caller.token).send({ displayName: 'Usta' });
    expect(created.status).toBe(201);
    return { ...caller, profileId: (created.body as { id: string }).id };
  }

  /**
   * An order between a fresh customer and a fresh master, in `status`, that
   * entered `COMPLETED` `completedHoursAgo` hours ago — or never, when that is
   * null.
   */
  async function seedOrder(
    options: { status?: OrderStatus; completedHoursAgo?: number | null } = {},
  ): Promise<SeededOrder> {
    const status = options.status ?? 'COMPLETED';
    const completedHoursAgo =
      options.completedHoursAgo === undefined ? 1 : options.completedHoursAgo;

    const customer = await seedCustomer();
    const master = await seedMaster();

    const address = await http('post', '/addresses', customer.token).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);

    const orderId = randomUUID();
    await pool.query(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status,
                           description, idempotency_key, price_minor, accepted_at)
       values ($1, $2, $3, $4, $5, $6::order_status, 'Mətbəxdə kran sızır.', $7, 6700,
               now() - interval '1 day')`,
      [
        orderId,
        customer.profileId,
        (address.body as { id: string }).id,
        serviceId,
        master.profileId,
        status,
        randomUUID(),
      ],
    );

    if (completedHoursAgo !== null) {
      await pool.query(
        `insert into order_status_history
           (id, order_id, from_status, to_status, actor_kind, actor_user_id, created_at)
         values ($1, $2, 'IN_PROGRESS', 'COMPLETED', 'master', $3,
                 now() - make_interval(hours => $4))`,
        [randomUUID(), orderId, master.userId, completedHoursAgo],
      );
    }

    return { orderId, customer, master };
  }

  async function aggregates(order: SeededOrder): Promise<{
    master: { sum: number; count: number };
    customer: { sum: number; count: number };
  }> {
    const master = await pool.query<{ rating_sum: number; rating_count: number }>(
      'select rating_sum, rating_count from masters where id = $1',
      [order.master.profileId],
    );
    const customer = await pool.query<{ rating_sum: number; rating_count: number }>(
      'select rating_sum, rating_count from customers where id = $1',
      [order.customer.profileId],
    );
    return {
      master: { sum: master.rows[0]?.rating_sum ?? -1, count: master.rows[0]?.rating_count ?? -1 },
      customer: {
        sum: customer.rows[0]?.rating_sum ?? -1,
        count: customer.rows[0]?.rating_count ?? -1,
      },
    };
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    // The budget this suite is about, per user. Per-IP is turned off: every
    // request in the file comes from one address.
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_USER_HOUR', String(REVIEW_BUDGET));
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
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

  describe('authentication', () => {
    it('refuses every route without a token', async () => {
      const { orderId } = await seedOrder();
      expect((await http('get', `/orders/${orderId}/reviews`)).status).toBe(401);
      expect((await http('post', `/orders/${orderId}/review`).send({ rating: 5 })).status).toBe(
        401,
      );
      expect((await http('put', `/orders/${orderId}/review`).send({ rating: 5 })).status).toBe(401);
    });
  });

  describe('validation', () => {
    it.each([
      ['a rating of 0', { rating: 0 }],
      ['a rating of 6', { rating: 6 }],
      ['a half star', { rating: 3.5 }],
      ['a rating as a string', { rating: '5' }],
      ['no rating', { comment: 'Yaxşı' }],
      ['an unknown field', { rating: 5, authorRole: 'master' }],
      ['a 501-character comment', { rating: 5, comment: 'a'.repeat(501) }],
    ])('refuses %s', async (_label, body) => {
      const { orderId, customer } = await seedOrder();
      const response = await submit(orderId, customer.token, body);
      expect(response.status).toBe(422);
      expect(errorCode(response)).toBe('VALIDATION_FAILED');
    });

    it('refuses an order id that is not a uuid', async () => {
      const customer = await seedCustomer();
      const response = await submit('not-a-uuid', customer.token, { rating: 5 });
      expect(response.status).toBe(422);
    });

    it('accepts exactly 500 characters, counted as characters', async () => {
      const { orderId, customer } = await seedOrder();
      const response = await submit(orderId, customer.token, {
        rating: 5,
        comment: 'ə'.repeat(500),
      });
      expect(response.status).toBe(201);
    });

    it('strips control characters other than newline, trims, and stores empty as null', async () => {
      const { orderId, customer, master } = await seedOrder();

      const fromCustomer = await submit(orderId, customer.token, {
        rating: 4,
        comment: '  Gec gəldi\u0007,\tamma\r\nyaxşı etdi.  ',
      });
      expect(fromCustomer.status).toBe(201);
      expect((fromCustomer.body as Review).comment).toBe('Gec gəldi,amma\nyaxşı etdi.');

      const fromMaster = await submit(orderId, master.token, { rating: 5, comment: '   \u0000 ' });
      expect(fromMaster.status).toBe(201);
      expect((fromMaster.body as Review).comment).toBeNull();
    });
  });

  describe('who may review', () => {
    it('lets the customer and the master each review, with the side decided by the server', async () => {
      const { orderId, customer, master } = await seedOrder();

      const fromCustomer = await submit(orderId, customer.token, { rating: 4 });
      expect(fromCustomer.status).toBe(201);
      expect(fromCustomer.body as Review).toMatchObject({
        orderId,
        authorRole: 'customer',
        rating: 4,
        comment: null,
        revealedAt: null,
        removedAt: null,
      });

      const fromMaster = await submit(orderId, master.token, { rating: 5 });
      expect(fromMaster.status).toBe(201);
      expect((fromMaster.body as Review).authorRole).toBe('master');
    });

    it('answers 404 to a customer who is not the order’s customer, on every route', async () => {
      const { orderId } = await seedOrder();
      const stranger = await seedCustomer();

      expect((await submit(orderId, stranger.token, { rating: 1 })).status).toBe(404);
      expect((await edit(orderId, stranger.token, { rating: 1 })).status).toBe(404);
      expect((await http('get', `/orders/${orderId}/reviews`, stranger.token)).status).toBe(404);
    });

    it('answers 404 to a master who is not the order’s master', async () => {
      const { orderId } = await seedOrder();
      const stranger = await seedMaster();

      const response = await submit(orderId, stranger.token, { rating: 1 });
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('answers the same 404 for an order that does not exist', async () => {
      const customer = await seedCustomer();
      const missing = await submit(randomUUID(), customer.token, { rating: 1 });
      expect(missing.status).toBe(404);
      expect(errorCode(missing)).toBe('NOT_FOUND');
    });

    it('writes nothing for a refused stranger', async () => {
      const { orderId } = await seedOrder();
      const stranger = await seedCustomer();
      await submit(orderId, stranger.token, { rating: 1 });

      const { rows } = await pool.query('select 1 from reviews where order_id = $1', [orderId]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('which orders may be reviewed', () => {
    it.each(['IN_PROGRESS', 'MASTER_ARRIVED', 'CANCELLED'] as const)(
      'refuses an order that is %s',
      async (status) => {
        const { orderId, customer } = await seedOrder({ status, completedHoursAgo: null });
        const response = await submit(orderId, customer.token, { rating: 3 });
        expect(response.status).toBe(409);
        expect(errorCode(response)).toBe('ORDER_NOT_REVIEWABLE');
      },
    );

    it.each(['PAYMENT_PENDING', 'PAID', 'DISPUTED', 'RESOLVED', 'REFUNDED'] as const)(
      'accepts an order that was completed and is now %s',
      async (status) => {
        const { orderId, master } = await seedOrder({ status });
        expect((await submit(orderId, master.token, { rating: 3 })).status).toBe(201);
      },
    );

    it('accepts a review just inside the seven-day window', async () => {
      const { orderId, customer } = await seedOrder({ completedHoursAgo: 167 });
      expect((await submit(orderId, customer.token, { rating: 2 })).status).toBe(201);
    });

    it('refuses a review once the window has closed, measured from COMPLETED', async () => {
      const { orderId, customer } = await seedOrder({ status: 'PAID', completedHoursAgo: 169 });
      const response = await submit(orderId, customer.token, { rating: 2 });
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('REVIEW_WINDOW_CLOSED');
    });
  });

  it('refuses a second review by the same side', async () => {
    const { orderId, customer } = await seedOrder();
    expect((await submit(orderId, customer.token, { rating: 5 })).status).toBe(201);

    const again = await submit(orderId, customer.token, { rating: 1 });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('REVIEW_ALREADY_SUBMITTED');

    const { rows } = await pool.query<{ rating: number }>(
      'select rating from reviews where order_id = $1',
      [orderId],
    );
    expect(rows).toEqual([{ rating: 5 }]);
  });

  describe('blindness (ADR-0042 § 3)', () => {
    it('keeps a sealed review invisible to the other party and visible to its author', async () => {
      const { orderId, customer, master } = await seedOrder();
      await submit(orderId, customer.token, { rating: 2, comment: 'Gecikdi.' });

      const authorView = await read(orderId, customer.token);
      expect(authorView).toMatchObject({
        role: 'customer',
        theirs: null,
        canReview: false,
        canEdit: true,
      });
      expect(authorView.mine).toMatchObject({ rating: 2, comment: 'Gecikdi.', revealedAt: null });

      const otherView = await read(orderId, master.token);
      expect(otherView).toMatchObject({
        role: 'master',
        mine: null,
        theirs: null,
        canReview: true,
        canEdit: false,
      });
    });

    it('reveals both reviews together when the second one arrives', async () => {
      const { orderId, customer, master } = await seedOrder();
      await submit(orderId, customer.token, { rating: 4, comment: 'Yaxşı iş.' });

      const second = await submit(orderId, master.token, { rating: 5 });
      expect(second.status).toBe(201);
      expect((second.body as Review).revealedAt).not.toBeNull();

      const customerView = await read(orderId, customer.token);
      const masterView = await read(orderId, master.token);
      expect(customerView.theirs).toMatchObject({ authorRole: 'master', rating: 5 });
      expect(masterView.theirs).toMatchObject({
        authorRole: 'customer',
        rating: 4,
        comment: 'Yaxşı iş.',
      });
      expect(customerView.mine?.revealedAt).toBe(masterView.theirs?.revealedAt);
      expect(customerView.canEdit).toBe(false);
    });

    it('reports the window and nothing to do on an order that is not completed', async () => {
      const { orderId, customer } = await seedOrder({
        status: 'IN_PROGRESS',
        completedHoursAgo: null,
      });
      expect(await read(orderId, customer.token)).toEqual({
        orderId,
        role: 'customer',
        mine: null,
        theirs: null,
        windowClosesAt: null,
        canReview: false,
        canEdit: false,
      });
    });

    it('reports when the window closes', async () => {
      const { orderId, customer } = await seedOrder({ completedHoursAgo: 24 });
      const { windowClosesAt } = await read(orderId, customer.token);
      const hoursLeft = (Date.parse(windowClosesAt ?? '') - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(143.9);
      expect(hoursLeft).toBeLessThan(144.1);
    });
  });

  describe('editing (ADR-0042 § 4)', () => {
    it('lets an author change a sealed review, and clears an omitted comment', async () => {
      const { orderId, customer } = await seedOrder();
      await submit(orderId, customer.token, { rating: 2, comment: 'Gecikdi.' });

      const changed = await edit(orderId, customer.token, {
        rating: 3,
        comment: 'Bir az gecikdi.',
      });
      expect(changed.status).toBe(200);
      expect(changed.body as Review).toMatchObject({ rating: 3, comment: 'Bir az gecikdi.' });

      const cleared = await edit(orderId, customer.token, { rating: 3 });
      expect(cleared.status).toBe(200);
      expect((cleared.body as Review).comment).toBeNull();
    });

    it('answers 404 to an edit when the caller has not reviewed yet', async () => {
      const { orderId, master } = await seedOrder();
      expect((await edit(orderId, master.token, { rating: 3 })).status).toBe(404);
    });

    it('refuses to change a revealed review', async () => {
      const { orderId, customer, master } = await seedOrder();
      await submit(orderId, customer.token, { rating: 4 });
      await submit(orderId, master.token, { rating: 5 });

      const response = await edit(orderId, customer.token, { rating: 1 });
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('REVIEW_ALREADY_REVEALED');

      expect((await read(orderId, master.token)).theirs?.rating).toBe(4);
    });

    it('refuses to change a sealed review once the window has closed', async () => {
      // Written directly: the API would not have accepted it this late, and the
      // trail is append-only, so the completion cannot be moved back instead.
      const order = await seedOrder({ completedHoursAgo: 169 });
      await pool.query(
        `insert into reviews (id, order_id, customer_id, master_id, author_role, rating)
         values ($1, $2, $3, $4, 'customer', 4)`,
        [randomUUID(), order.orderId, order.customer.profileId, order.master.profileId],
      );

      const response = await edit(order.orderId, order.customer.token, { rating: 1 });
      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('REVIEW_WINDOW_CLOSED');
    });
  });

  describe('aggregates (ADR-0042 § 6)', () => {
    it('do not move when the first review is submitted or edited', async () => {
      const order = await seedOrder();
      await submit(order.orderId, order.customer.token, { rating: 1 });
      await edit(order.orderId, order.customer.token, { rating: 2 });

      expect(await aggregates(order)).toEqual({
        master: { sum: 0, count: 0 },
        customer: { sum: 0, count: 0 },
      });
    });

    it('move once, at reveal, by the ratings as last edited', async () => {
      const order = await seedOrder();
      await submit(order.orderId, order.customer.token, { rating: 1 });
      await edit(order.orderId, order.customer.token, { rating: 4 });
      await submit(order.orderId, order.master.token, { rating: 3 });

      expect(await aggregates(order)).toEqual({
        master: { sum: 4, count: 1 },
        customer: { sum: 3, count: 1 },
      });
    });

    it('accumulate across orders for the same master', async () => {
      const first = await seedOrder();
      await submit(first.orderId, first.customer.token, { rating: 5 });
      await submit(first.orderId, first.master.token, { rating: 5 });

      const customer = await seedCustomer();
      const address = await http('post', '/addresses', customer.token).send({
        formattedAddress: 'Füzuli küçəsi 12',
        latitude: 40.409264,
        longitude: 49.867092,
      });
      const secondOrderId = randomUUID();
      await pool.query(
        `insert into orders (id, customer_id, address_id, service_id, master_id, status,
                             description, idempotency_key, price_minor, accepted_at)
         values ($1, $2, $3, $4, $5, 'COMPLETED', 'Kran.', $6, 6700, now())`,
        [
          secondOrderId,
          customer.profileId,
          (address.body as { id: string }).id,
          serviceId,
          first.master.profileId,
          randomUUID(),
        ],
      );
      await pool.query(
        `insert into order_status_history
           (id, order_id, from_status, to_status, actor_kind, actor_user_id)
         values ($1, $2, 'IN_PROGRESS', 'COMPLETED', 'master', $3)`,
        [randomUUID(), secondOrderId, first.master.userId],
      );
      await submit(secondOrderId, customer.token, { rating: 2 });
      await submit(secondOrderId, first.master.token, { rating: 4 });

      expect((await aggregates(first)).master).toEqual({ sum: 7, count: 2 });
    });
  });

  it('reveals both and counts each exactly once when both sides submit at the same moment', async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => seedOrder()));

    for (const order of orders) {
      const [fromCustomer, fromMaster] = await Promise.all([
        submit(order.orderId, order.customer.token, { rating: 4 }),
        submit(order.orderId, order.master.token, { rating: 2 }),
      ]);
      expect(fromCustomer.status).toBe(201);
      expect(fromMaster.status).toBe(201);

      const { rows } = await pool.query<{ sealed: string }>(
        `select count(*) filter (where revealed_at is null) as sealed from reviews
          where order_id = $1`,
        [order.orderId],
      );
      expect(rows[0]?.sealed).toBe('0');
      expect(await aggregates(order)).toEqual({
        master: { sum: 4, count: 1 },
        customer: { sum: 2, count: 1 },
      });
    }
  });

  it('lets one side submit concurrently only once', async () => {
    const { orderId, customer } = await seedOrder();
    const responses = await Promise.all([
      submit(orderId, customer.token, { rating: 4 }),
      submit(orderId, customer.token, { rating: 5 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('rate limits submission and editing together, per user', async () => {
    const { orderId, customer } = await seedOrder();
    expect((await submit(orderId, customer.token, { rating: 3 })).status).toBe(201);

    for (let spent = 1; spent < REVIEW_BUDGET; spent += 1) {
      expect((await edit(orderId, customer.token, { rating: 3 })).status).toBe(200);
    }

    const refused = await edit(orderId, customer.token, { rating: 3 });
    expect(refused.status).toBe(429);
    expect(errorCode(refused)).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBeDefined();
  });
});
