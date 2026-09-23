import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Message } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { PushEnvelope } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { DevicesService } from '../src/modules/devices/devices.service';
import { ServicesService } from '../src/modules/services/services.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * A message the recipient did not see becomes a push, end to end through the
 * real conversation endpoints, the real deferred queue and the real
 * notification worker, stopping at `StubPushSender` (issue #180,
 * ADR-0033 § 5).
 *
 * **"Did not see" is asserted, not "had no socket".** The design decision in
 * `message-notifications.service.ts` is that the database's unread state,
 * checked once `MESSAGE_PUSH_DELAY_SECONDS` has passed, is the cluster-wide
 * answer to presence — so the online case here is a recipient who read the
 * message inside the window, which is exactly what the open conversation
 * screen does (#182).
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[message-${String(tokenCounter)}]`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
/** Short, so each test waits one window; long enough that a read inside it is not a race. */
const PUSH_DELAY_SECONDS = 2;
const TEST_TIMEOUT_MS = 60_000;

const SECRET_WORDS = 'Qapının kodu 4417-dir';

interface Person {
  readonly userId: string;
  readonly accessToken: string;
  readonly pushToken: string;
}

interface SeededMaster extends Person {
  readonly masterId: string;
}

describe('a message nobody read raises a push (issue #180)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let push: StubPushSender;
  let serviceId: string;
  let serviceName: string;

  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${accessToken}`);
  }

  async function eventually(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(
          `Condition was still false after ${String(timeoutMs)}ms; sent: ${JSON.stringify(push.sent.map((e) => [e.pushToken, e.data.kind]))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The message pushes addressed to one phone. */
  function messagePushesTo(pushToken: string): PushEnvelope[] {
    return push.sent.filter(
      (envelope) => envelope.pushToken === pushToken && envelope.data.kind === 'message-received',
    );
  }

  /** Waits out one full window plus the worker's slack, then reads. */
  async function afterTheWindow(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, PUSH_DELAY_SECONDS * 1_000 + 1_500));
  }

  async function signIn(
    displayName: string,
    role: 'customers' | 'masters',
  ): Promise<Person & { profileId: string }> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const pushToken = nextToken();
    await app
      .get(DevicesService)
      .register(
        { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
        { expoPushToken: pushToken, platform: 'android' },
      );
    const profile = await post(`/${role}`, pair.accessToken).send({ displayName });
    expect(profile.status).toBe(201);
    return {
      userId: created.user.id,
      accessToken: pair.accessToken,
      pushToken,
      profileId: (profile.body as { id: string }).id,
    };
  }

  async function seedMaster(): Promise<SeededMaster> {
    const caller = await signIn('Usta Anar', 'masters');
    const masterId = caller.profileId;
    await pool.query(
      `update masters set verification_status = 'active', is_available = true,
                          commission_debt_minor = 0
        where id = $1`,
      [masterId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 6700, true)`,
      [masterId, serviceId],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), now())`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await app.get(MasterPresenceService).refresh(masterId);
    seededMasterIds.push(masterId);
    return { ...caller, masterId };
  }

  /** An order a real master really accepted, with both parties' phones registered. */
  async function acceptedOrder(): Promise<{
    orderId: string;
    customer: Person;
    master: SeededMaster;
  }> {
    const master = await seedMaster();
    const customer = await signIn('Leyla', 'customers');
    const address = await post('/addresses', customer.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    const order = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: 'Mətbəxdə kran sızır.',
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    const orderId = (order.body as { id: string }).id;

    let offerId: string | undefined;
    await eventually(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `select id from order_offers where order_id = $1 and master_id = $2 and status = 'offered'`,
        [orderId, master.masterId],
      );
      offerId = rows[0]?.id;
      return offerId !== undefined;
    });
    const accepted = await post(
      `/masters/me/offers/${offerId ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);

    return { orderId, customer, master };
  }

  function send(orderId: string, token: string, body: string) {
    return post(`/orders/${orderId}/messages`, token).send({ body });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '600');
    set('PRESENCE_HEARTBEAT_SECONDS', '300');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '600');
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('DISPATCH_INITIAL_RADIUS_M', '5000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');
    set('MESSAGE_PUSH_DELAY_SECONDS', String(PUSH_DELAY_SECONDS));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    push = app.get<StubPushSender>(PUSH_SENDER);
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
    serviceName = (await app.get(ServicesService).getServiceById(serviceId, ['az'])).name;
  }, 120_000);

  afterEach(async () => {
    push.outcomes.clear();
    if (seededMasterIds.length > 0) {
      await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
        seededMasterIds,
      ]);
      seededMasterIds.length = 0;
    }
  });

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

  it(
    'an unread message reaches the recipient as a push naming the sender and the order',
    async () => {
      const { orderId, customer, master } = await acceptedOrder();

      expect((await send(orderId, customer.accessToken, SECRET_WORDS)).status).toBe(201);

      await eventually(() => messagePushesTo(master.pushToken).length === 1);
      const [envelope] = messagePushesTo(master.pushToken);

      expect(envelope).toMatchObject({
        title: 'Leyla',
        channelId: 'messages',
        data: { kind: 'message-received', orderId },
      });
      expect(envelope?.body).toContain(serviceName);
      // Never to the sender.
      expect(messagePushesTo(customer.pushToken)).toHaveLength(0);

      // And the message is in the history the recipient opens.
      const history = await request(app.getHttpServer())
        .get(`/orders/${orderId}/messages`)
        .set('authorization', `Bearer ${master.accessToken}`);
      expect((history.body as { items: Message[] }).items.map((m) => m.body)).toContain(
        SECRET_WORDS,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the push never carries the words',
    async () => {
      const { orderId, master } = await acceptedOrder();

      expect((await send(orderId, master.accessToken, SECRET_WORDS)).status).toBe(201);

      const customerToken = (
        await pool.query<{ expo_push_token: string }>(
          `select d.expo_push_token from devices d
             join customers c on c.user_id = d.user_id
             join orders o on o.customer_id = c.id
            where o.id = $1`,
          [orderId],
        )
      ).rows[0]?.expo_push_token;
      await eventually(() => messagePushesTo(customerToken ?? '').length === 1);

      const everything = JSON.stringify(push.sent);
      expect(everything).not.toContain(SECRET_WORDS);
      expect(everything).not.toContain('4417');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a recipient who read it inside the window is not pushed',
    async () => {
      const { orderId, customer, master } = await acceptedOrder();

      const sent = await send(orderId, customer.accessToken, 'Giriş arxa tərəfdəndir');
      expect(sent.status).toBe(201);
      // What the open conversation screen does the moment the message is on screen.
      const read = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
        throughMessageId: (sent.body as Message).id,
      });
      expect(read.status).toBe(200);

      await afterTheWindow();
      expect(messagePushesTo(master.pushToken)).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ten messages in quick succession do not become ten notifications',
    async () => {
      const { orderId, customer, master } = await acceptedOrder();

      for (let index = 0; index < 10; index += 1) {
        expect((await send(orderId, customer.accessToken, `Mesaj ${String(index)}`)).status).toBe(
          201,
        );
      }

      await eventually(() => messagePushesTo(master.pushToken).length >= 1);
      await afterTheWindow();

      // One window, or two if the burst straddled a window boundary — never ten.
      expect(messagePushesTo(master.pushToken).length).toBeLessThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a token the provider reports unreachable is retired, as order pushes retire them',
    async () => {
      const { orderId, customer, master } = await acceptedOrder();
      push.outcomes.set(master.pushToken, { status: 'unreachable' });

      expect((await send(orderId, customer.accessToken, 'Salam')).status).toBe(201);

      await eventually(async () => {
        const { rows } = await pool.query<{ revoked_reason: string | null }>(
          'select revoked_reason from devices where expo_push_token = $1',
          [master.pushToken],
        );
        return rows[0]?.revoked_reason === 'unreachable';
      });
    },
    TEST_TIMEOUT_MS,
  );
});
