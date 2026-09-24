import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminReview,
  CursorPage,
  OrderReviews,
  RatingRecalculation,
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
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * An admin removing a review (issue #224,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md) § 7), over real HTTP.
 *
 * Reviews are written and revealed through the consumer endpoints, so the
 * aggregates under test were produced by the real reveal path, and the
 * removal has to undo exactly what that path did.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

interface Party {
  readonly token: string;
  readonly profileId: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customer: Party;
  readonly master: Party;
}

describe('an admin removing a review (issue #224)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let admin: { adminUserId: string; accessToken: string };
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function http(method: 'get' | 'post', path: string, token: string | null) {
    const pending = request(app.getHttpServer())[method](path);
    return token === null ? pending : pending.set('authorization', `Bearer ${token}`);
  }

  function remove(reviewId: string, body: object, token: string | null = admin.accessToken) {
    return http('post', `/admin/reviews/${reviewId}/removal`, token).send(body);
  }

  async function party(role: 'customers' | 'masters'): Promise<Party> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const profile = await http('post', `/${role}`, pair.accessToken).send({ displayName: 'Ad' });
    expect(profile.status).toBe(201);
    return { token: pair.accessToken, profileId: (profile.body as { id: string }).id };
  }

  async function completedOrder(): Promise<SeededOrder> {
    const customer = await party('customers');
    const master = await party('masters');
    const masterUser = await pool.query<{ user_id: string }>(
      'select user_id from masters where id = $1',
      [master.profileId],
    );
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
       values ($1, $2, $3, $4, $5, 'COMPLETED', 'Kran sızır.', $6, 6700, now())`,
      [
        orderId,
        customer.profileId,
        (address.body as { id: string }).id,
        serviceId,
        master.profileId,
        randomUUID(),
      ],
    );
    await pool.query(
      `insert into order_status_history
         (id, order_id, from_status, to_status, actor_kind, actor_user_id, created_at)
       values ($1, $2, 'IN_PROGRESS', 'COMPLETED', 'master', $3, now() - interval '1 hour')`,
      [randomUUID(), orderId, masterUser.rows[0]?.user_id],
    );
    return { orderId, customer, master };
  }

  async function review(order: SeededOrder, side: 'customer' | 'master', rating: number) {
    const token = side === 'customer' ? order.customer.token : order.master.token;
    const response = await http('post', `/orders/${order.orderId}/review`, token).send({
      rating,
      comment: 'Pis söz.',
    });
    expect(response.status).toBe(201);
    return response.body as Review;
  }

  async function aggregate(table: 'masters' | 'customers', id: string) {
    const { rows } = await pool.query<{ rating_sum: number; rating_count: number }>(
      `select rating_sum, rating_count from ${table} where id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditFor(reviewId: string) {
    const { rows } = await pool.query<{ action: string; reason: string; admin_user_id: string }>(
      `select action, reason, admin_user_id from admin_audit_log
        where target_type = 'review' and target_id = $1`,
      [reviewId],
    );
    return rows;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Moderator',
    });
    const session = await app.get(AdminSessionService).start(created.id);
    admin = { adminUserId: created.id, accessToken: session.accessToken };
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
    it('refuses both routes without an admin session', async () => {
      const order = await completedOrder();
      const written = await review(order, 'customer', 2);

      expect((await remove(written.id, { reason: 'Təhqir.' }, null)).status).toBe(401);
      expect((await remove(written.id, { reason: 'Təhqir.' }, order.master.token)).status).toBe(
        401,
      );
      expect((await http('get', '/admin/reviews', null)).status).toBe(401);
      expect((await http('get', '/admin/reviews', order.customer.token)).status).toBe(401);
      expect((await auditFor(written.id)).length).toBe(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['no reason', {}],
      ['a blank reason', { reason: '   ' }],
      ['a reason over 600 characters', { reason: 'a'.repeat(601) }],
      ['an unknown field', { reason: 'Təhqir.', silent: true }],
    ])('refuses %s', async (_label, body) => {
      const response = await remove(randomUUID(), body);
      expect(response.status).toBe(422);
      expect((response.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a review id that is not a uuid, and an unknown listing filter', async () => {
      expect((await remove('nope', { reason: 'Təhqir.' })).status).toBe(422);
      expect((await http('get', '/admin/reviews?author=me', admin.accessToken)).status).toBe(422);
    });

    it('answers 404 for a review that does not exist', async () => {
      expect((await remove(randomUUID(), { reason: 'Təhqir.' })).status).toBe(404);
    });
  });

  it('removes a revealed review from its subject’s aggregate and reads, and audits it', async () => {
    const order = await completedOrder();
    const byCustomer = await review(order, 'customer', 1);
    await review(order, 'master', 5);
    expect(await aggregate('masters', order.master.profileId)).toEqual({
      rating_sum: 1,
      rating_count: 1,
    });

    const response = await remove(byCustomer.id, { reason: '  Təhqiramiz ifadə.  ' });
    expect(response.status).toBe(200);
    expect(response.body as AdminReview).toMatchObject({
      id: byCustomer.id,
      removedByAdminId: admin.adminUserId,
      removalReason: 'Təhqiramiz ifadə.',
    });

    expect(await aggregate('masters', order.master.profileId)).toEqual({
      rating_sum: 0,
      rating_count: 0,
    });
    // The other side's review is untouched.
    expect(await aggregate('customers', order.customer.profileId)).toEqual({
      rating_sum: 5,
      rating_count: 1,
    });

    expect(await auditFor(byCustomer.id)).toEqual([
      { action: 'review.remove', reason: 'Təhqiramiz ifadə.', admin_user_id: admin.adminUserId },
    ]);

    // Gone for the subject …
    const subjectView = (await http('get', `/orders/${order.orderId}/reviews`, order.master.token))
      .body as OrderReviews;
    expect(subjectView.theirs).toBeNull();
    const received = (await http('get', '/me/reviews/received?role=master', order.master.token))
      .body as CursorPage<Review>;
    expect(received.items).toEqual([]);

    // … and shown to its author, marked as removed, without the reason.
    const authorView = (await http('get', `/orders/${order.orderId}/reviews`, order.customer.token))
      .body as OrderReviews;
    expect(authorView.mine?.id).toBe(byCustomer.id);
    expect(authorView.mine?.removedAt).not.toBeNull();
    expect(JSON.stringify(authorView)).not.toContain('Təhqiramiz');
  });

  it('removes a sealed review without touching the aggregate, and it is not counted at reveal', async () => {
    const order = await completedOrder();
    const sealed = await review(order, 'customer', 1);

    expect((await remove(sealed.id, { reason: 'Spam.' })).status).toBe(200);
    expect(await aggregate('masters', order.master.profileId)).toEqual({
      rating_sum: 0,
      rating_count: 0,
    });

    // The master's review arrives and reveals both; the removed one stays out.
    await review(order, 'master', 4);
    expect(await aggregate('masters', order.master.profileId)).toEqual({
      rating_sum: 0,
      rating_count: 0,
    });
    expect(await aggregate('customers', order.customer.profileId)).toEqual({
      rating_sum: 4,
      rating_count: 1,
    });
  });

  it('refuses a second removal and keeps the first one’s record', async () => {
    const order = await completedOrder();
    const written = await review(order, 'master', 2);

    expect((await remove(written.id, { reason: 'Birinci.' })).status).toBe(200);
    const again = await remove(written.id, { reason: 'İkinci.' });
    expect(again.status).toBe(409);
    expect((again.body as ErrorEnvelope).error.code).toBe('REVIEW_ALREADY_REMOVED');

    expect(await auditFor(written.id)).toHaveLength(1);
    const { rows } = await pool.query<{ removal_reason: string }>(
      'select removal_reason from reviews where id = $1',
      [written.id],
    );
    expect(rows[0]?.removal_reason).toBe('Birinci.');
  });

  it('leaves the aggregates exactly what a recalculation would compute', async () => {
    const response = await http('post', '/admin/ratings/recalculate', admin.accessToken).send({});
    expect(response.status).toBe(200);
    expect(response.body as RatingRecalculation).toMatchObject({
      mastersCorrected: 0,
      customersCorrected: 0,
    });
  });

  describe('GET /admin/reviews', () => {
    it('lists an order’s reviews with removals and their reasons, newest first', async () => {
      const order = await completedOrder();
      const first = await review(order, 'customer', 3);
      const second = await review(order, 'master', 4);
      await remove(first.id, { reason: 'Səbəb.' });

      const response = await http(
        'get',
        `/admin/reviews?orderId=${order.orderId}`,
        admin.accessToken,
      );
      expect(response.status).toBe(200);
      const page = response.body as CursorPage<AdminReview>;
      expect(page.items.map((item) => item.id)).toEqual([second.id, first.id]);
      expect(page.items[1]).toMatchObject({
        removalReason: 'Səbəb.',
        removedByAdminId: admin.adminUserId,
        customerId: order.customer.profileId,
        masterId: order.master.profileId,
        comment: 'Pis söz.',
      });
    });

    it('filters by master and pages with a cursor', async () => {
      const order = await completedOrder();
      const a = await review(order, 'customer', 3);
      const b = await review(order, 'master', 4);

      const first = (
        await http(
          'get',
          `/admin/reviews?masterId=${order.master.profileId}&limit=1`,
          admin.accessToken,
        )
      ).body as CursorPage<AdminReview>;
      expect(first.items.map((item) => item.id)).toEqual([b.id]);
      expect(first.nextCursor).not.toBeNull();

      const second = (
        await http(
          'get',
          `/admin/reviews?masterId=${order.master.profileId}&limit=1&cursor=${first.nextCursor ?? ''}`,
          admin.accessToken,
        )
      ).body as CursorPage<AdminReview>;
      expect(second.items.map((item) => item.id)).toEqual([a.id]);
      expect(second.nextCursor).toBeNull();
    });
  });
});
