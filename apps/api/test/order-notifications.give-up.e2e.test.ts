// Set before anything imports the config module, the way
// `dispatch.e2e.test.ts` does it: the shipped search window is minutes long
// and this suite exists to watch one end inside a test.
process.env.DISPATCH_INITIAL_RADIUS_M = '1';
process.env.DISPATCH_RADIUS_STEP_SECONDS = '1';
process.env.DISPATCH_TOTAL_TIMEOUT_SECONDS = '3';

import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { DevicesService } from '../src/modules/devices/devices.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The one event whose whole point is that silence is the worst outcome
 * (issue #144): a search that ends having found nobody.
 *
 * **Its own file because of one number.** The give-up tick fires at
 * `DISPATCH_TOTAL_TIMEOUT_SECONDS`, and a value short enough to observe inside
 * a test is a value that would end every other suite's orders underneath it —
 * so `order-notifications.e2e.test.ts` sets it long and this one sets it
 * short. Neither can do both.
 *
 * The order here reaches nobody by construction: a one-metre search radius,
 * and no master seeded at all.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99460${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

describe('a search that ends with nobody (issue #144)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let devices: DevicesService;
  let push: StubPushSender;
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

  async function eventually(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    devices = app.get(DevicesService);
    push = app.get<StubPushSender>(PUSH_SENDER);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database?.drop();
  });

  it('tells the customer, and only the customer', async () => {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const pushToken = `ExponentPushToken[${'g'.repeat(22)}]`;
    await devices.register(
      { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
      { expoPushToken: pushToken, platform: 'android' },
    );

    await post('/customers', pair.accessToken).send({ displayName: 'Müştəri' }).expect(201);
    const address = await post('/addresses', pair.accessToken)
      .send({
        formattedAddress: 'Nizami küçəsi 203',
        latitude: SEARCH_POINT.latitude,
        longitude: SEARCH_POINT.longitude,
      })
      .expect(201);

    const order = await post('/orders', pair.accessToken)
      .send({
        serviceId,
        addressId: (address.body as { id: string }).id,
        description: 'Kran sızır.',
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const orderId = (order.body as { id: string }).id;

    await eventually(async () => {
      const { rows } = await pool.query<{ status: string }>(
        'select status from orders where id = $1',
        [orderId],
      );
      return rows[0]?.status === 'NO_MASTER_FOUND';
    });

    await eventually(() => push.sent.length >= 1);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.pushToken).toBe(pushToken);
    expect(push.sent[0]?.data.kind).toBe('order-no-master-found');
    expect(push.sent[0]?.data.orderId).toBe(orderId);
  });
});
