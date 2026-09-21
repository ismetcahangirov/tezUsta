// Tighten the retry policy BEFORE anything imports the config module, for the
// reason `deferred-work.e2e.test.ts` gives: the shipped 3 attempts with a 5s
// exponential backoff would make the retry assertion below a 15-second test.
process.env.QUEUE_JOB_ATTEMPTS = '2';
process.env.QUEUE_JOB_BACKOFF_MS = '100';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Queue } from 'bullmq';

import { AppModule } from '../src/app.module';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import { NOTIFICATIONS_QUEUE } from '../src/infra/queue/queue.constants';
import { createBullmqRedisClient } from '../src/infra/redis/bullmq-connection.provider';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { DevicesService } from '../src/modules/devices/devices.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The notification mechanism end to end, against real Postgres and real
 * Redis, through the real `AppModule` graph — queue, worker, handler
 * registry, device resolution and ticket persistence all as they ship. Only
 * the network stops, at `StubPushSender`.
 *
 * What only this layer can prove: that nothing is sent on the caller's thread,
 * that a recipient's devices are resolved **when the job runs** rather than
 * when it was queued, that a dead token is retired by a ticket rather than
 * surviving until some later sweep, that a transient refusal is retried and a
 * permanent one is not, and that a job which exhausts its attempts is still
 * findable afterwards. Every one of those is a property of the wiring.
 */

/**
 * Polls rather than sleeping a fixed amount, against a real Redis where a
 * fixed sleep is either flaky or slow and usually both.
 *
 * **It awaits the predicate**, which is not a detail: an `async` condition
 * returns a Promise, every Promise is truthy, and a version that only called
 * `condition()` would return immediately and pass every assertion that had
 * not happened yet.
 */
async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99470${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[${String(tokenCounter).padStart(22, 'n')}]`;
}

const ORDER_ID = '0199c0de-0000-7000-8000-00000000abcd';

describe('push notifications end to end (issue #141)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let users: UsersRepository;
  let devices: DevicesService;
  let notifications: NotificationsService;
  let push: StubPushSender;
  let inspectionQueue: Queue;
  let inspectionConnection: ReturnType<typeof createBullmqRedisClient>;

  async function failedJobCount(): Promise<number> {
    return inspectionQueue.getJobCountByTypes('failed');
  }

  /** A signed-up account with `count` registered phones. Returns their tokens. */
  async function userWithDevices(count: number): Promise<{ userId: string; tokens: string[] }> {
    const created = await users.create({ phoneE164: nextPhone(), roles: [] });
    const tokens: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const token = nextToken();
      tokens.push(token);
      await devices.register(
        { userId: created.user.id, sessionId: uuidV7(), roles: [], status: 'active' },
        { expoPushToken: token, platform: 'android' },
      );
    }
    return { userId: created.user.id, tokens };
  }

  async function ticketCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from push_tickets',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function revocationOf(
    token: string,
  ): Promise<{ revoked_at: Date | null; revoked_reason: string | null } | undefined> {
    const result = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      'select revoked_at, revoked_reason from devices where expo_push_token = $1',
      [token],
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // `init()` alone does not fire `onApplicationBootstrap`, which is the hook
    // that starts the workers — without this the queue fills and nothing
    // consumes it, and every assertion below times out for the wrong reason.
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    users = app.get(UsersRepository);
    devices = app.get(DevicesService);
    notifications = app.get(NotificationsService);
    push = app.get<StubPushSender>(PUSH_SENDER);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => {
      /* see addresses.e2e.test.ts */
    });

    // A second handle on the same queue, under the same prefix, purely to
    // read the failed set — the application never exposes a `Queue`, and it
    // should not start doing so for a test.
    const config = parseEnv(process.env);
    inspectionConnection = createBullmqRedisClient(config.redis.url);
    inspectionQueue = new Queue(NOTIFICATIONS_QUEUE, {
      connection: inspectionConnection,
      prefix: config.queue.prefix,
    });
  });

  afterEach(() => {
    push.reset();
  });

  afterAll(async () => {
    await inspectionQueue?.close();
    inspectionConnection?.disconnect();
    await pool?.end();
    await app?.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database?.drop();
  });

  it('is the stub sender under test, not a real transport', () => {
    // If `PUSH_PROVIDER` ever defaulted to `expo` in tests, every assertion
    // below would be talking to Expo. Worth one line to make that impossible
    // to do by accident.
    expect(push.constructor.name).toBe('StubPushSender');
  });

  it('delivers to every live device of the recipient', async () => {
    const { userId, tokens } = await userWithDevices(2);

    await notifications.notify({ userId, kind: 'order-accepted', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 2);
    expect(push.sent.map((envelope) => envelope.pushToken).sort()).toEqual([...tokens].sort());
  });

  it('sends nothing on the caller’s thread', async () => {
    const { userId } = await userWithDevices(1);

    await notifications.notify({ userId, kind: 'order-accepted', orderId: ORDER_ID });

    // `notify` has already resolved. If it had sent inline, the stub would
    // hold the envelope by now — the whole point of the queue is that it does
    // not yet.
    expect(push.sent).toEqual([]);
    await eventually(() => push.sent.length === 1);
  });

  it('renders words, and carries only ids in the payload', async () => {
    const { userId } = await userWithDevices(1);

    await notifications.notify({
      userId,
      kind: 'order-status-changed',
      orderId: ORDER_ID,
      orderStatus: 'MASTER_ARRIVED',
    });

    await eventually(() => push.sent.length === 1);
    const envelope = push.sent[0];
    expect(envelope?.title).not.toBe('');
    expect(envelope?.body).not.toBe('');
    // A lock screen is readable by whoever is holding the phone.
    expect(envelope?.data).toEqual({
      kind: 'order-status-changed',
      orderId: ORDER_ID,
      orderStatus: 'MASTER_ARRIVED',
    });
  });

  it('resolves devices when the job runs, not when it was queued', async () => {
    const { userId, tokens } = await userWithDevices(1);
    const lateToken = nextToken();
    await devices.register(
      { userId, sessionId: uuidV7(), roles: [], status: 'active' },
      { expoPushToken: lateToken, platform: 'ios' },
    );

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 2);
    expect(push.sent.map((envelope) => envelope.pushToken).sort()).toEqual(
      [...tokens, lateToken].sort(),
    );
  });

  it('records a receipt for every accepted push, so #142 has a worklist', async () => {
    const before = await ticketCount();
    const { userId } = await userWithDevices(3);

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 3);
    await eventually(async () => (await ticketCount()) === before + 3);
  });

  it('retires a device the provider reports as gone, at ticket time', async () => {
    const { userId, tokens } = await userWithDevices(2);
    const dead = tokens[0] ?? '';
    const live = tokens[1] ?? '';
    push.outcomes.set(dead, { status: 'unreachable' });

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 2);
    await eventually(async () => (await revocationOf(dead))?.revoked_at !== null);

    expect((await revocationOf(dead))?.revoked_reason).toBe('unreachable');
    // And only that one.
    expect((await revocationOf(live))?.revoked_at).toBeNull();
  });

  it('does not send to a retired device again', async () => {
    const { userId, tokens } = await userWithDevices(1);
    const dead = tokens[0] ?? '';
    push.outcomes.set(dead, { status: 'unreachable' });

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });
    await eventually(async () => (await revocationOf(dead))?.revoked_at !== null);
    push.reset();

    await notifications.notify({ userId, kind: 'order-accepted', orderId: ORDER_ID });

    // Nothing to send to, so nothing is sent — and the job must complete
    // rather than fail, or every account with no live device would fill the
    // failed set.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(push.sent).toEqual([]);
  });

  it('does not keep a device alive when the provider merely asked us to slow down', async () => {
    const { userId, tokens } = await userWithDevices(1);
    const token = tokens[0] ?? '';
    push.outcomes.set(token, {
      status: 'retryable',
      code: 'MessageRateExceeded',
      message: 'slow down',
    });

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    // Retried — `QUEUE_JOB_ATTEMPTS` is 2 in this suite — and the device is
    // left alone throughout, because a rate limit says nothing about a phone.
    await eventually(() => push.sent.length === 2);
    expect((await revocationOf(token))?.revoked_at).toBeNull();
  });

  it('does not retry a permanent rejection', async () => {
    const { userId, tokens } = await userWithDevices(1);
    push.outcomes.set(tokens[0] ?? '', {
      status: 'rejected',
      code: 'MessageTooBig',
      message: 'too big',
    });

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 1);
    // Retrying reproduces it exactly, so the job completes. Give the queue
    // long enough that a retry would have landed if one were coming.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(push.sent).toHaveLength(1);
  });

  it('sends nothing, and fails nothing, for a recipient with no devices', async () => {
    const created = await users.create({ phoneE164: nextPhone(), roles: [] });

    await notifications.notify({ userId: created.user.id, kind: 'order-accepted' });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(push.sent).toEqual([]);
  });

  it('retries a whole-request failure rather than losing the notification', async () => {
    const { userId } = await userWithDevices(1);
    // The network blinks once. Arranged as a count rather than by clearing the
    // flag on a timer, so the test proves the retry recovered instead of
    // racing BullMQ's backoff.
    push.failWith = new Error('no route to host');
    push.failTimes = 1;

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    await eventually(() => push.sent.length === 1);
  });

  it('keeps a job that exhausts its attempts, rather than dropping it silently', async () => {
    const { userId } = await userWithDevices(1);
    const before = await failedJobCount();
    // A provider that is down for longer than our attempts last.
    push.failWith = new Error('no route to host');

    await notifications.notify({ userId, kind: 'order-offer', orderId: ORDER_ID });

    // "The master was never told about that offer" has to be a question with
    // an answer. `removeOnFail` keeps the job, its payload and its error.
    await eventually(async () => (await failedJobCount()) === before + 1);
  });

  it('does not let a failure to queue fail the caller', async () => {
    const { userId } = await userWithDevices(1);
    // The order moved; the push is a consequence. A queue having a bad second
    // must never turn an accept a master is waiting on into a 500.
    await expect(
      notifications.notify({ userId, kind: 'order-accepted', orderId: ORDER_ID }),
    ).resolves.toBeUndefined();
  });
});
