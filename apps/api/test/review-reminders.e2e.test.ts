import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderStatus } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { PushEnvelope } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { DeferredWorkService } from '../src/infra/queue/deferred-work.service';
import { DISPATCH_QUEUE } from '../src/infra/queue/queue.constants';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { DevicesService } from '../src/modules/devices/devices.service';
import { OrderNotificationsRegistry } from '../src/modules/orders/order-notifications.registry';
import {
  REVIEW_REMINDER_JOB,
  ReviewTimersService,
  reviewReminderJobId,
} from '../src/modules/reviews/review-timers.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The one review reminder (issue #226, ADR-0042 § 1), through the real
 * transition endpoint, the real queue and the real notification worker,
 * stopping at `StubPushSender`.
 *
 * **The job's decision is run directly** rather than waited for: the reminder
 * is due a day after completion, and what matters is that completing an order
 * schedules exactly one job for that moment, and that the job — whenever it
 * runs — re-checks before it sends. Both halves are asserted separately.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99459${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[review-${String(tokenCounter)}]`;
}

interface Party {
  readonly userId: string;
  readonly token: string;
  readonly pushToken: string;
  readonly profileId: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customer: Party;
  readonly master: Party;
}

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the review reminder (issue #226)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let push: StubPushSender;
  let queue: Queue;
  let timers: ReviewTimersService;
  let serviceId: string;
  const scheduledJobIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function http(method: 'post' | 'put', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`);
  }

  function remindersTo(party: Party): PushEnvelope[] {
    return push.sent.filter(
      (envelope) =>
        envelope.pushToken === party.pushToken && envelope.data.kind === 'review-reminder',
    );
  }

  /** Lets the notification worker drain what the job queued. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  async function party(role: 'customers' | 'masters'): Promise<Party> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const pushToken = nextToken();
    await app
      .get(DevicesService)
      .register(
        { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
        { expoPushToken: pushToken, platform: 'android' },
      );
    const profile = await http('post', `/${role}`, pair.accessToken).send({ displayName: 'Ad' });
    expect(profile.status).toBe(201);
    return {
      userId: created.user.id,
      token: pair.accessToken,
      pushToken,
      profileId: (profile.body as { id: string }).id,
    };
  }

  /** An order in `status`, completed `completedHoursAgo` hours ago unless null. */
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
                 now() - make_interval(hours => $4))`,
        [randomUUID(), orderId, master.userId, completedHoursAgo],
      );
    }
    return { orderId, customer, master };
  }

  async function reviewAs(order: SeededOrder, side: 'customer' | 'master'): Promise<void> {
    const token = side === 'customer' ? order.customer.token : order.master.token;
    const response = await http('post', `/orders/${order.orderId}/review`, token).send({
      rating: 5,
    });
    expect(response.status).toBe(201);
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('REVIEW_SUBMIT_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    push = app.get<StubPushSender>(PUSH_SENDER);
    queue = app.get<Queue>(getQueueToken(DISPATCH_QUEUE));
    timers = app.get(ReviewTimersService);
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  afterEach(() => {
    push.outcomes.clear();
  });

  afterAll(async () => {
    // A day-long delayed job must not outlive the database it names.
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

  it('completing an order schedules one reminder, due a day later', async () => {
    const order = await seedOrder('IN_PROGRESS', null);
    const jobId = reviewReminderJobId(order.orderId);
    scheduledJobIds.push(jobId);

    const completed = await http(
      'post',
      `/orders/${order.orderId}/transitions`,
      order.master.token,
    ).send({ to: 'COMPLETED' });
    expect(completed.status).toBe(200);

    // The transition raises its events after the response is written.
    let job = await queue.getJob(jobId);
    for (let attempt = 0; attempt < 50 && job === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await queue.getJob(jobId);
    }
    expect(job?.name).toBe(REVIEW_REMINDER_JOB);
    expect(job?.data).toEqual({ orderId: order.orderId });
    expect(job?.opts.delay).toBe(24 * 3_600_000);
    expect(await job?.getState()).toBe('delayed');
  });

  it('a second COMPLETED event for the same order does not schedule a second reminder', async () => {
    const order = await seedOrder('COMPLETED', 0);
    const jobId = reviewReminderJobId(order.orderId);
    scheduledJobIds.push(jobId);
    const event = {
      orderId: order.orderId,
      customerId: order.customer.profileId,
      masterId: order.master.profileId,
      to: 'COMPLETED' as const,
      priceMinor: 6700,
      actorUserId: order.master.userId,
    };

    const registry = app.get(OrderNotificationsRegistry);
    await registry.transitioned(event);
    const first = await queue.getJob(jobId);
    await registry.transitioned(event);

    const delayed = await queue.getDelayed();
    const mine = delayed.filter(
      (job) =>
        job.name === REVIEW_REMINDER_JOB &&
        (job.data as { orderId?: unknown }).orderId === order.orderId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.timestamp).toBe(first?.timestamp);
  });

  it('reminds both parties with the order id and kind only', async () => {
    const order = await seedOrder('COMPLETED', 24);

    await timers.remind({ orderId: order.orderId });
    await eventually(
      () => remindersTo(order.customer).length === 1 && remindersTo(order.master).length === 1,
    );

    for (const envelope of [...remindersTo(order.customer), ...remindersTo(order.master)]) {
      expect(envelope.data).toEqual({
        kind: 'review-reminder',
        orderId: order.orderId,
        orderStatus: undefined,
      });
      expect(envelope.channelId).toBe('review-reminders');
    }
  });

  it('does not remind a party who already reviewed', async () => {
    const order = await seedOrder('COMPLETED', 24);
    await reviewAs(order, 'customer');

    await timers.remind({ orderId: order.orderId });
    await eventually(() => remindersTo(order.master).length === 1);
    await settle();

    expect(remindersTo(order.customer)).toHaveLength(0);
  });

  it('does not remind a party who switched review reminders off', async () => {
    const order = await seedOrder('COMPLETED', 24);
    const off = await http('put', '/notification-preferences', order.customer.token).send({
      preferences: [{ category: 'review-reminders', enabled: false }],
    });
    expect(off.status).toBe(200);

    await timers.remind({ orderId: order.orderId });
    await eventually(() => remindersTo(order.master).length === 1);
    await settle();

    expect(remindersTo(order.customer)).toHaveLength(0);
  });

  it('reminds nobody once the window has closed, or on an order that is not reviewable', async () => {
    const late = await seedOrder('PAID', 169);
    const cancelled = await seedOrder('CANCELLED', null);

    await timers.remind({ orderId: late.orderId });
    await timers.remind({ orderId: cancelled.orderId });
    await settle();

    for (const order of [late, cancelled]) {
      expect(remindersTo(order.customer)).toHaveLength(0);
      expect(remindersTo(order.master)).toHaveLength(0);
    }
  });

  it('reminds nobody once both have reviewed', async () => {
    const order = await seedOrder('COMPLETED', 24);
    await reviewAs(order, 'customer');
    await reviewAs(order, 'master');

    await timers.remind({ orderId: order.orderId });
    await settle();

    expect(remindersTo(order.customer)).toHaveLength(0);
    expect(remindersTo(order.master)).toHaveLength(0);
  });
});
