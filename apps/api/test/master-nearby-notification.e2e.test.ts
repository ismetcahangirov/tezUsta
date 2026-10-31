import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { MasterNearbyNotifier } from '../src/modules/notifications/master-nearby-notifier.service';
import type { NotificationRequest } from '../src/modules/notifications/notification.types';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * "Your master is nearby" (issue #414), against a real Postgres + PostGIS and
 * Redis through the real `AppModule`.
 *
 * Orders are seeded with SQL straight into the status under test, so each
 * case says exactly where the order stands and where the master reports from.
 * One case goes through `POST /masters/me/location`, to prove the wiring from
 * a report to the push; the rest call the listener the registry calls.
 */

/** The order's address: Nizami küçəsi, Baku. */
const ADDRESS = { latitude: 40.372613, longitude: 49.842717 };
/** About 300 m north of it — inside the default 500 m. */
const NEAR = { latitude: 40.37531, longitude: 49.842717 };
/** About 2 km north — outside. */
const FAR = { latitude: 40.39061, longitude: 49.842717 };

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

describe('the "master nearby" push (issue #414)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessions: SessionsService;
  let presence: MasterPresenceService;
  let notifier: MasterNearbyNotifier;
  let notify: MockInstance<(request: NotificationRequest) => Promise<void>>;
  let serviceId: string;

  interface Seeded {
    readonly orderId: string;
    readonly masterId: string;
    readonly masterToken: string;
    readonly customerUserId: string;
  }

  /** A customer, their address, a verified master online, and the order between them. */
  async function seed(status: string, from = FAR): Promise<Seeded> {
    const customer = await usersRepo.create({ email: nextEmail(), roles: ['customer'] });
    const customerId = randomUUID();
    await pool.query('insert into customers (id, user_id, display_name) values ($1, $2, $3)', [
      customerId,
      customer.user.id,
      'Müştəri',
    ]);
    const addressId = randomUUID();
    await pool.query(
      `insert into addresses (id, customer_id, formatted_address, position)
       values ($1, $2, 'Nizami küçəsi 203', ST_SetSRID(ST_MakePoint($3, $4), 4326))`,
      [addressId, customerId, ADDRESS.longitude, ADDRESS.latitude],
    );

    const masterUser = await usersRepo.create({ email: nextEmail(), roles: ['master'] });
    const masterId = randomUUID();
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status, is_available)
       values ($1, $2, 'Usta', 'active', true)`,
      [masterId, masterUser.user.id],
    );
    await grantTestSubscription(pool, masterId);
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), now() - interval '1 minute')`,
      [randomUUID(), masterId, from.longitude, from.latitude],
    );
    await presence.refresh(masterId);

    const orderId = randomUUID();
    await pool.query(
      `insert into orders (id, customer_id, address_id, service_id, status, description,
                           idempotency_key, master_id, price_minor, accepted_at)
       values ($1, $2, $3, $4, $5, 'nearby fixture', $6, $7, 6700, now() - interval '10 minutes')`,
      [orderId, customerId, addressId, serviceId, status, randomUUID(), masterId],
    );

    const { accessToken } = await sessions.startSession({ userId: masterUser.user.id });
    return { orderId, masterId, masterToken: accessToken, customerUserId: customer.user.id };
  }

  function reported(masterId: string, point: { latitude: number; longitude: number }) {
    return notifier.onReported({ masterId, ...point, recordedAt: new Date() });
  }

  function nearbyPushes(): NotificationRequest[] {
    return notify.mock.calls.map(([call]) => call).filter((call) => call.kind === 'master-nearby');
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    await runSeed(database.url);
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessions = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    notifier = app.get(MasterNearbyNotifier);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    const { rows } = await pool.query<{ id: string }>('select id from services limit 1');
    serviceId = rows[0]?.id ?? '';
  }, 60_000);

  beforeEach(() => {
    notify = vi.spyOn(app.get(NotificationsService), 'notify').mockResolvedValue(undefined);
  });

  afterEach(() => {
    notify.mockRestore();
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  it('a report over HTTP from inside the radius sends one push, with ids only', async () => {
    const order = await seed('MASTER_ON_THE_WAY', NEAR);

    const res = await request(app.getHttpServer())
      .post('/masters/me/location')
      .set('authorization', `Bearer ${order.masterToken}`)
      .send(NEAR);

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(nearbyPushes()).toHaveLength(1);
    });
    const [push] = nearbyPushes();
    expect(push).toEqual({
      userId: order.customerUserId,
      kind: 'master-nearby',
      orderId: order.orderId,
      orderStatus: 'MASTER_ON_THE_WAY',
    });
    const payload = JSON.stringify(push);
    expect(payload).not.toContain(String(NEAR.latitude));
    expect(payload).not.toContain(String(NEAR.longitude));
  });

  it('sends nothing from outside the radius, and once on crossing in', async () => {
    const order = await seed('MASTER_ON_THE_WAY');

    await reported(order.masterId, FAR);
    expect(nearbyPushes()).toEqual([]);

    await reported(order.masterId, NEAR);
    expect(nearbyPushes()).toHaveLength(1);
  });

  it('sends nothing more from inside, on leaving and re-entering, or twice at once', async () => {
    const order = await seed('MASTER_ON_THE_WAY');

    await Promise.all([reported(order.masterId, NEAR), reported(order.masterId, NEAR)]);
    await reported(order.masterId, NEAR);
    await reported(order.masterId, FAR);
    await reported(order.masterId, NEAR);

    expect(nearbyPushes()).toHaveLength(1);
  });

  it.each(['ACCEPTED', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED'])(
    'sends nothing while the order is %s',
    async (status) => {
      const order = await seed(status);

      await reported(order.masterId, NEAR);

      expect(nearbyPushes()).toEqual([]);
    },
  );

  it('gives the next master their own push after a re-dispatch, and the old one none', async () => {
    const order = await seed('MASTER_ON_THE_WAY');
    await reported(order.masterId, NEAR);
    expect(nearbyPushes()).toHaveLength(1);

    // Re-dispatched and accepted by somebody else: a new master and a new accept.
    const next = await seed('ACCEPTED');
    await pool.query(`update orders set status = 'CANCELLED' where id = $1`, [next.orderId]);
    await pool.query(`update orders set master_id = $2, accepted_at = now() where id = $1`, [
      order.orderId,
      next.masterId,
    ]);

    await reported(order.masterId, NEAR);
    expect(nearbyPushes()).toHaveLength(1);

    await reported(next.masterId, NEAR);
    expect(nearbyPushes()).toHaveLength(2);
  });
});
