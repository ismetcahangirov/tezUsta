import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderReviews, OrderStatus, RatingRecalculation } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { DeferredWorkService } from '../src/infra/queue/deferred-work.service';
import { DISPATCH_QUEUE } from '../src/infra/queue/queue.constants';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  REVIEW_WINDOW_CLOSE_JOB,
  ReviewRevealService,
  reviewWindowCloseJobId,
} from '../src/modules/reviews/review-reveal.service';
import { reviewReminderJobId } from '../src/modules/reviews/review-timers.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Revealing at window close, and recalculating aggregates (issue #223,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md) §§ 3 and 6).
 *
 * The window is shortened to **two hours** for this file, and completions are
 * written into `order_status_history` a set number of hours ago, so "the window
 * has closed" is a fact of the data rather than something to wait for. The job
 * and the sweep are run directly, as their handlers; that completing an order
 * schedules the job is asserted through the real transition endpoint.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

const WINDOW_HOURS = 2;
const BATCH_SIZE = 2;

interface Party {
  readonly userId: string;
  readonly token: string;
  readonly profileId: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customer: Party;
  readonly master: Party;
}

describe('the review window closing (issue #223)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let reveal: ReviewRevealService;
  let queue: Queue;
  let serviceId: string;
  let admin: { adminUserId: string; accessToken: string };
  const scheduledJobIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function http(method: 'get' | 'post', path: string, token?: string) {
    const pending = request(app.getHttpServer())[method](path);
    return token === undefined ? pending : pending.set('authorization', `Bearer ${token}`);
  }

  async function party(role: 'customers' | 'masters'): Promise<Party> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const profile = await http('post', `/${role}`, pair.accessToken).send({ displayName: 'Ad' });
    expect(profile.status).toBe(201);
    return {
      userId: created.user.id,
      token: pair.accessToken,
      profileId: (profile.body as { id: string }).id,
    };
  }

  async function seedOrder(
    status: OrderStatus,
    completedHoursAgo: number | null,
  ): Promise<SeededOrder> {
    const customer = await party('customers');
    const master = await party('masters');
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
       values ($1, $2, $3, $4, $5, $6::order_status, 'Kran sızır.', $7, 6700, now())`,
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
                 now() - make_interval(mins => $4))`,
        [randomUUID(), orderId, master.userId, Math.round(completedHoursAgo * 60)],
      );
    }
    return { orderId, customer, master };
  }

  /** A sealed review written straight into the table, as a submission would have left it. */
  async function sealedReview(
    order: SeededOrder,
    authorRole: 'customer' | 'master',
    rating: number,
    removedBy?: string,
  ): Promise<void> {
    await pool.query(
      `insert into reviews (id, order_id, customer_id, master_id, author_role, rating,
                            removed_at, removed_by_admin_id, removal_reason)
       values ($1, $2, $3, $4, $5::review_author_role, $6, $7, $8, $9)`,
      [
        randomUUID(),
        order.orderId,
        order.customer.profileId,
        order.master.profileId,
        authorRole,
        rating,
        removedBy === undefined ? null : new Date(),
        removedBy ?? null,
        removedBy === undefined ? null : 'Təhqir.',
      ],
    );
  }

  async function sealedCount(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from reviews where order_id = $1 and revealed_at is null`,
      [orderId],
    );
    return rows[0]?.n ?? -1;
  }

  async function aggregate(
    table: 'masters' | 'customers',
    id: string,
  ): Promise<{ rating_sum: number; rating_count: number }> {
    const { rows } = await pool.query<{ rating_sum: number; rating_count: number }>(
      `select rating_sum, rating_count from ${table} where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no ${table} row`);
    }
    return row;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('REVIEW_WINDOW_HOURS', String(WINDOW_HOURS));
    set('REVIEW_REMINDER_DELAY_HOURS', '1');
    set('MAINTENANCE_BATCH_SIZE', String(BATCH_SIZE));
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    reveal = app.get(ReviewRevealService);
    queue = app.get<Queue>(getQueueToken(DISPATCH_QUEUE));
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
    });
    const session = await app.get(AdminSessionService).start(created.id);
    admin = { adminUserId: created.id, accessToken: session.accessToken };
  }, 120_000);

  afterAll(async () => {
    for (const jobId of scheduledJobIds) {
      await app.get(DeferredWorkService).cancel(jobId);
    }
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

  it('completing an order schedules the window close, due when the window ends', async () => {
    const order = await seedOrder('IN_PROGRESS', null);
    const jobId = reviewWindowCloseJobId(order.orderId);
    scheduledJobIds.push(jobId, reviewReminderJobId(order.orderId));

    const completed = await http(
      'post',
      `/orders/${order.orderId}/transitions`,
      order.master.token,
    ).send({ to: 'COMPLETED' });
    expect(completed.status).toBe(200);

    let job = await queue.getJob(jobId);
    for (let attempt = 0; attempt < 50 && job === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await queue.getJob(jobId);
    }
    expect(job?.name).toBe(REVIEW_WINDOW_CLOSE_JOB);
    expect(job?.data).toEqual({ orderId: order.orderId });
    expect(job?.opts.delay).toBe(WINDOW_HOURS * 3_600_000);
  });

  describe('the window-close job', () => {
    it('reveals a lone sealed review after the window and counts it', async () => {
      const order = await seedOrder('COMPLETED', WINDOW_HOURS + 1);
      await sealedReview(order, 'customer', 4);

      expect(await reveal.closeWindow({ orderId: order.orderId })).toBe(1);

      expect(await sealedCount(order.orderId)).toBe(0);
      expect(await aggregate('masters', order.master.profileId)).toEqual({
        rating_sum: 4,
        rating_count: 1,
      });

      // Now visible to the party it is about.
      const view = await http('get', `/orders/${order.orderId}/reviews`, order.master.token);
      expect((view.body as OrderReviews).theirs).toMatchObject({
        authorRole: 'customer',
        rating: 4,
      });
    });

    it('changes nothing when it runs again, or when the sweep follows it', async () => {
      const order = await seedOrder('PAID', WINDOW_HOURS + 1);
      await sealedReview(order, 'master', 2);

      expect(await reveal.closeWindow({ orderId: order.orderId })).toBe(1);
      const after = await aggregate('customers', order.customer.profileId);

      expect(await reveal.closeWindow({ orderId: order.orderId })).toBe(0);
      await reveal.sweep();

      expect(await aggregate('customers', order.customer.profileId)).toEqual(after);
      expect(after).toEqual({ rating_sum: 2, rating_count: 1 });
    });

    it('reveals nothing while the window is still open', async () => {
      const order = await seedOrder('COMPLETED', WINDOW_HOURS - 0.5);
      await sealedReview(order, 'customer', 5);

      expect(await reveal.closeWindow({ orderId: order.orderId })).toBe(0);
      await reveal.sweep();

      expect(await sealedCount(order.orderId)).toBe(1);
      expect(await aggregate('masters', order.master.profileId)).toEqual({
        rating_sum: 0,
        rating_count: 0,
      });
    });

    it('reveals a removed review with the rest but never counts it', async () => {
      const order = await seedOrder('COMPLETED', WINDOW_HOURS + 1);
      await sealedReview(order, 'customer', 1, admin.adminUserId);
      await sealedReview(order, 'master', 5);

      expect(await reveal.closeWindow({ orderId: order.orderId })).toBe(2);

      expect(await aggregate('masters', order.master.profileId)).toEqual({
        rating_sum: 0,
        rating_count: 0,
      });
      expect(await aggregate('customers', order.customer.profileId)).toEqual({
        rating_sum: 5,
        rating_count: 1,
      });
    });
  });

  describe('the sweep', () => {
    it('reveals every expired order across several batches, then finds nothing', async () => {
      const orders: SeededOrder[] = [];
      for (let index = 0; index < BATCH_SIZE * 2 + 1; index += 1) {
        const order = await seedOrder('COMPLETED', WINDOW_HOURS + 2);
        await sealedReview(order, 'customer', 3);
        orders.push(order);
      }

      expect(await reveal.sweep()).toBeGreaterThanOrEqual(orders.length);
      for (const order of orders) {
        expect(await sealedCount(order.orderId)).toBe(0);
        expect(await aggregate('masters', order.master.profileId)).toEqual({
          rating_sum: 3,
          rating_count: 1,
        });
      }

      expect(await reveal.sweep()).toBe(0);
    });
  });

  describe('POST /admin/ratings/recalculate', () => {
    async function allRuns(): Promise<number> {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from admin_audit_log
          where action = 'rating.recalculate' and target_type = 'rating_recalculation'`,
      );
      return rows[0]?.n ?? -1;
    }

    /** `null` sends no token at all — a default parameter would swallow `undefined`. */
    function recalculate(body: object, token: string | null = admin.accessToken) {
      return http('post', '/admin/ratings/recalculate', token ?? undefined).send(body);
    }

    it('refuses a request with no admin session, and a consumer token', async () => {
      const consumer = await party('customers');
      expect((await recalculate({}, null)).status).toBe(401);
      expect((await recalculate({}, consumer.token)).status).toBe(401);
    });

    it.each([
      ['both a master and a customer', { masterId: randomUUID(), customerId: randomUUID() }],
      ['a master id that is not a uuid', { masterId: 'nope' }],
      ['an unknown field', { everything: true }],
    ])('refuses %s', async (_label, body) => {
      const response = await recalculate(body);
      expect(response.status).toBe(422);
      expect((response.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for a master that does not exist', async () => {
      expect((await recalculate({ masterId: randomUUID() })).status).toBe(404);
    });

    it('restores a deliberately corrupted master aggregate, and audits it', async () => {
      const order = await seedOrder('COMPLETED', WINDOW_HOURS + 1);
      await sealedReview(order, 'customer', 4);
      await reveal.closeWindow({ orderId: order.orderId });
      await pool.query(`update masters set rating_sum = 9, rating_count = 2 where id = $1`, [
        order.master.profileId,
      ]);

      const response = await recalculate({ masterId: order.master.profileId });
      expect(response.status).toBe(200);
      expect(response.body as RatingRecalculation).toEqual({
        scope: 'master',
        mastersCorrected: 1,
        customersCorrected: 0,
      });
      expect(await aggregate('masters', order.master.profileId)).toEqual({
        rating_sum: 4,
        rating_count: 1,
      });

      const audit = await pool.query<{ action: string; admin_user_id: string }>(
        `select action, admin_user_id from admin_audit_log
          where target_type = 'master' and target_id = $1`,
        [order.master.profileId],
      );
      expect(audit.rows).toEqual([
        { action: 'rating.recalculate', admin_user_id: admin.adminUserId },
      ]);
    });

    it('recalculates everybody, correcting only what drifted, and audits the run', async () => {
      const order = await seedOrder('COMPLETED', WINDOW_HOURS + 1);
      await sealedReview(order, 'master', 5);
      await reveal.closeWindow({ orderId: order.orderId });
      await pool.query(`update customers set rating_sum = 0, rating_count = 0 where id = $1`, [
        order.customer.profileId,
      ]);

      const runsBefore = await allRuns();
      const first = await recalculate({});
      expect(first.status).toBe(200);
      expect(first.body as RatingRecalculation).toEqual({
        scope: 'all',
        mastersCorrected: 0,
        customersCorrected: 1,
      });
      expect(await aggregate('customers', order.customer.profileId)).toEqual({
        rating_sum: 5,
        rating_count: 1,
      });

      const second = await recalculate({});
      expect(second.body as RatingRecalculation).toEqual({
        scope: 'all',
        mastersCorrected: 0,
        customersCorrected: 0,
      });

      expect((await allRuns()) - runsBefore).toBe(2);
    });
  });
});
