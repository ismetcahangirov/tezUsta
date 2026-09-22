import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { NOTIFICATIONS_QUEUE } from '../src/infra/queue/queue.constants';
import { createBullmqRedisClient } from '../src/infra/redis/bullmq-connection.provider';
import type { Actor } from '../src/modules/auth/auth.types';
import { DevicesService } from '../src/modules/devices/devices.service';
import { NotificationPreferencesService } from '../src/modules/notifications/notification-preferences.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The preference filter where it actually has to work: in the worker, against
 * real Postgres and real Redis, through the real `AppModule` graph (#143).
 *
 * What only this layer can prove is the claim the whole issue turns on —
 * that the filter runs **at send time and not at enqueue**. A unit test over
 * the resolution rules (`notification-categories.test.ts`) cannot see the gap
 * between a job being queued and a job being run, and that gap is exactly
 * where a user switches a category off. Here the queue is paused across it, so
 * the window is not a race but a fact of the test.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[${String(tokenCounter).padStart(22, 'p')}]`;
}

const ORDER_ID = '0199c0de-0000-7000-8000-0000000fee01';

/** Polls rather than sleeping — see `notifications.e2e.test.ts` on why. */
async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('notification preferences at send time (issue #143)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let users: UsersRepository;
  let devices: DevicesService;
  let notifications: NotificationsService;
  let preferences: NotificationPreferencesService;
  let push: StubPushSender;
  let queue: Queue;
  let queueConnection: ReturnType<typeof createBullmqRedisClient>;

  interface Recipient {
    readonly actor: Actor;
    readonly userId: string;
    readonly tokens: string[];
  }

  async function recipientWithDevices(count: number): Promise<Recipient> {
    const created = await users.create({ phoneE164: nextPhone(), roles: [] });
    const actor: Actor = {
      userId: created.user.id,
      sessionId: uuidV7(),
      roles: [],
      status: 'active',
    };
    const tokens: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const token = nextToken();
      tokens.push(token);
      await devices.register(actor, { expoPushToken: token, platform: 'android' });
    }
    return { actor, userId: created.user.id, tokens };
  }

  /**
   * True once the queue holds nothing that could still send.
   *
   * **Asserting "nothing was sent" needs this and not a sleep.** A fixed wait
   * is either flaky or slow and usually both, and issue #122 is the record of
   * what happens when a test asserts that a job has not run yet: a fast
   * machine falsifies it. Waiting for the queue to be empty asserts that the
   * job ran *and* sent nothing, which is the property under test.
   */
  async function drained(): Promise<boolean> {
    return (
      (await queue.getJobCountByTypes(
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waiting-children',
      )) === 0
    );
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // `init()` alone does not fire `onApplicationBootstrap`, the hook that
    // starts the workers — see `notifications.e2e.test.ts`.
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    users = app.get(UsersRepository);
    devices = app.get(DevicesService);
    notifications = app.get(NotificationsService);
    preferences = app.get(NotificationPreferencesService);
    push = app.get<StubPushSender>(PUSH_SENDER);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => {
      /* see addresses.e2e.test.ts */
    });

    const config = parseEnv(process.env);
    queueConnection = createBullmqRedisClient(config.redis.url);
    queue = new Queue(NOTIFICATIONS_QUEUE, {
      connection: queueConnection,
      prefix: config.queue.prefix,
    });
  });

  afterEach(async () => {
    push.reset();
    // A suite that failed mid-test must not leave the queue paused for the
    // next file this worker process runs — they share `QUEUE_PREFIX`.
    await queue.resume();
  });

  afterAll(async () => {
    await queue?.close();
    queueConnection?.disconnect();
    await pool?.end();
    await app?.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database?.drop();
  });

  /**
   * The Android channel reaches the transport, through the real worker (#157).
   *
   * `notification-categories.test.ts` proves the mapping and
   * `expo-push-sender.test.ts` proves the adapter forwards it; what is only
   * provable here is that the *delivery job* sets it at all. The field is
   * required on `PushEnvelope` precisely so that this cannot regress silently,
   * and this test is the one that would notice if the requirement were ever
   * relaxed back to an optional field.
   *
   * **Two kinds, one channel** is asserted rather than one kind per channel:
   * the collapsing is the design (a progress step and a redispatch are not
   * separate lines in a phone's settings screen), and it is the part a future
   * refactor is most likely to get wrong by keying channels off the kind.
   */
  it('addresses each notification to its category’s Android channel', async () => {
    const recipient = await recipientWithDevices(1);

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-accepted',
      orderId: ORDER_ID,
    });
    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-redispatched',
      orderId: ORDER_ID,
    });

    await eventually(() => push.sent.length === 2);
    expect(
      push.sent.map((envelope) => [envelope.data.kind, envelope.channelId]).sort(),
    ).toStrictEqual([
      ['order-accepted', 'order-accepted'],
      // Deliberately not `order-redispatched`: it shares the cancellation
      // switch, so it shares the cancellation channel.
      ['order-redispatched', 'order-cancelled'],
    ]);
  });

  it('sends nothing for a category the recipient switched off', async () => {
    const recipient = await recipientWithDevices(1);
    await preferences.replace(recipient.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
      orderStatus: 'MASTER_ON_THE_WAY',
    });

    await eventually(drained);
    expect(push.sent).toEqual([]);
  });

  it('suppresses only that category and nothing else', async () => {
    const recipient = await recipientWithDevices(1);
    await preferences.replace(recipient.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });
    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-accepted',
      orderId: ORDER_ID,
    });

    await eventually(drained);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data.kind).toBe('order-accepted');
  });

  /**
   * **The claim the issue turns on.** The job is queued while the category is
   * still on, the user switches it off while the job waits, and the job must
   * then send nothing. Filtering at enqueue would pass every other test in
   * this file and fail this one.
   */
  it('honours a preference changed after the job was enqueued', async () => {
    const recipient = await recipientWithDevices(1);

    await queue.pause();
    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });
    // The job is queued and provably not running: with the queue paused, the
    // worker cannot have picked it up.
    // `'waiting'` and not `'paused'`: BullMQ 6 pauses a queue by a flag in its
    // meta hash rather than by moving jobs, so a paused queue's jobs stay in
    // the wait list. Verified against the shipped `bullmq@6.3.7` — its
    // `JobType` union has no `'paused'` member at all.
    await eventually(async () => (await queue.getJobCountByTypes('waiting')) === 1);

    await preferences.replace(recipient.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });
    await queue.resume();

    await eventually(drained);
    expect(push.sent).toEqual([]);
  });

  it('silences the category on every device the recipient has', async () => {
    const recipient = await recipientWithDevices(3);
    await preferences.replace(recipient.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });

    await eventually(drained);
    expect(push.sent).toEqual([]);
  });

  it('sends again once the category is switched back on', async () => {
    const recipient = await recipientWithDevices(2);
    await preferences.replace(recipient.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });
    await preferences.replace(recipient.actor, { preferences: [] });

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });

    await eventually(() => push.sent.length === 2);
    expect(push.sent.map((envelope) => envelope.pushToken).sort()).toEqual(
      [...recipient.tokens].sort(),
    );
  });

  it('leaves another user’s delivery alone', async () => {
    const silenced = await recipientWithDevices(1);
    const other = await recipientWithDevices(1);
    await preferences.replace(silenced.actor, {
      preferences: [{ category: 'order-progress', enabled: false }],
    });

    await notifications.notify({
      userId: silenced.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });
    await notifications.notify({
      userId: other.userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
    });

    await eventually(drained);
    expect(push.sent.map((envelope) => envelope.pushToken)).toEqual(other.tokens);
  });

  /**
   * A row that outlived the rule allowing it — written while the category was
   * changeable, read after the rule tightened. The policy has to win, or the
   * rule would hold only for users who arrived after it. Written straight to
   * the table because the API refuses to produce this state, which is the
   * point: the worker must be correct about data the API can no longer create.
   */
  it('ignores a stored row that would silence a transactional category', async () => {
    const recipient = await recipientWithDevices(1);
    await pool.query(
      'insert into notification_preferences (user_id, category, is_enabled) values ($1, $2, false)',
      [recipient.userId, 'order-accepted'],
    );

    await notifications.notify({
      userId: recipient.userId,
      kind: 'order-accepted',
      orderId: ORDER_ID,
    });

    await eventually(() => push.sent.length === 1);
    expect(push.sent[0]?.pushToken).toBe(recipient.tokens[0]);
  });
});
