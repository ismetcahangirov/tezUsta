import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminDashboard, OrderStatus } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The operational dashboard (issue #246, `admin-flow.md` § 6,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 7), against a
 * database seeded with exactly the orders each number should count.
 */
describe('GET /admin/dashboard (issue #246)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let token: string;
  let serviceId: string;
  let categoryId: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let counter = 0;

  async function one<T>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await pool.query<T & object>(sql, params);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`No row from: ${sql}`);
    }
    return row;
  }

  async function newUser(): Promise<string> {
    counter += 1;
    return (
      await one<{ id: string }>(
        `insert into users (id, phone_e164, status) values (gen_random_uuid(), $1, 'active') returning id`,
        [`+99451${String(counter).padStart(7, '0')}`],
      )
    ).id;
  }

  async function newMaster(available: boolean): Promise<string> {
    return (
      await one<{ id: string }>(
        `insert into masters (id, user_id, display_name, verification_status, is_available)
         values (gen_random_uuid(), $1, 'Rəşad', 'active', $2) returning id`,
        [await newUser(), available],
      )
    ).id;
  }

  /**
   * An order in `status` at (lat, lng), created `ageDays` ago, whose trail
   * says it was accepted when `accepted` is true.
   */
  async function seedOrder(
    status: OrderStatus,
    options: { lat?: number; lng?: number; ageDays?: number; accepted?: boolean } = {},
  ): Promise<string> {
    const userId = await newUser();
    const customer = await one<{ id: string }>(
      `insert into customers (id, user_id, display_name) values (gen_random_uuid(), $1, 'Aygün') returning id`,
      [userId],
    );
    const address = await one<{ id: string }>(
      `insert into addresses (id, customer_id, formatted_address, position)
       values (gen_random_uuid(), $1, 'Bakı', ST_SetSRID(ST_MakePoint($2, $3), 4326)) returning id`,
      [customer.id, options.lng ?? 49.8671, options.lat ?? 40.4093],
    );
    const masterId =
      status === 'SEARCHING' || status === 'NO_MASTER_FOUND' ? null : await newMaster(false);
    const age = `now() - interval '${String(options.ageDays ?? 0)} days'`;
    const order = await one<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status, description,
                           idempotency_key, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Kran sızır.', $6, ${age}, ${age})
       returning id`,
      [customer.id, address.id, serviceId, masterId, status, `key-${randomUUID()}`],
    );
    if (options.accepted === true) {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind)
         values (gen_random_uuid(), $1, 'SEARCHING', 'ACCEPTED', 'system')`,
        [order.id],
      );
    }
    if (status === 'CANCELLED') {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, actor_user_id)
         values (gen_random_uuid(), $1, 'ACCEPTED', 'CANCELLED', 'customer', $2)`,
        [order.id, userId],
      );
    }
    if (status === 'DISPUTED') {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, actor_user_id)
         values (gen_random_uuid(), $1, 'COMPLETED', 'DISPUTED', 'customer', $2)`,
        [order.id, userId],
      );
    }
    return order.id;
  }

  function dashboard(query = '') {
    return request(app.getHttpServer())
      .get(`/admin/dashboard${query}`)
      .set('authorization', `Bearer ${token}`);
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const service = await one<{ id: string; category_id: string }>(
      `select id, category_id from services order by id limit 1`,
      [],
    );
    serviceId = service.id;
    categoryId = service.category_id;

    const admin = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Admin',
      // The narrowest role: every role holds dashboard.read.
      roles: ['finance'],
    });
    token = (await app.get(AdminSessionService).start(admin.id)).accessToken;

    // Two unfilled orders in one cell, one elsewhere; one filled; one
    // cancelled after accept; one searching; one disputed; one too old to count.
    await seedOrder('NO_MASTER_FOUND', { lat: 40.401, lng: 49.861 });
    await seedOrder('NO_MASTER_FOUND', { lat: 40.405, lng: 49.865 });
    await seedOrder('NO_MASTER_FOUND', { lat: 40.5, lng: 50.1 });
    await seedOrder('ACCEPTED', { accepted: true });
    await seedOrder('CANCELLED', { accepted: true });
    await seedOrder('SEARCHING');
    await seedOrder('DISPUTED', { accepted: true });
    await seedOrder('NO_MASTER_FOUND', { ageDays: 10 });

    // Two available masters with fresh positions, one switched off.
    for (const available of [true, true, false]) {
      const masterId = await newMaster(available);
      await pool.query(
        `insert into master_locations (id, master_id, position)
         values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.87, 40.41), 4326))`,
        [masterId],
      );
    }
  }, 60_000);

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

  it('counts the last seven days, and never counts an unfilled order as a cancellation', async () => {
    const res = await dashboard();
    expect(res.status).toBe(200);
    const body = res.body as AdminDashboard;
    expect(body.orders).toMatchObject({
      created: 7,
      filled: 3,
      unfilled: 3,
      searching: 1,
      cancelled: 1,
      cancelledAfterAccept: 1,
      cancelledBy: [{ actorKind: 'customer', count: 1 }],
    });
    expect(body.orders.fillRate).toBeCloseTo(3 / 7, 3);
    expect(body.orders.cancellationRate).toBeCloseTo(1 / 7, 3);
  });

  it('groups unfilled orders by category and by 0.02° cell', async () => {
    const body = (await dashboard()).body as AdminDashboard;
    expect(body.cellDegrees).toBe(0.02);
    expect(body.unfilledByCategory).toEqual([expect.objectContaining({ categoryId, count: 3 })]);
    const [busiest] = body.unfilledByArea;
    expect(busiest?.count).toBe(2);
    expect(busiest?.lat).toBeCloseTo(40.41, 5);
    expect(busiest?.lng).toBeCloseTo(49.87, 5);
    expect(body.unfilledByArea.reduce((sum, cell) => sum + cell.count, 0)).toBe(3);
  });

  it('counts available masters by cell, and open disputes', async () => {
    const body = (await dashboard()).body as AdminDashboard;
    expect(body.mastersAvailable.total).toBe(2);
    expect(body.mastersAvailable.byArea).toEqual([expect.objectContaining({ count: 2 })]);
    expect(body.openDisputes.count).toBe(1);
    expect(body.openDisputes.oldestDisputedAt).not.toBeNull();
  });

  it('includes an older order when the range reaches it', async () => {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const body = (await dashboard(`?from=${from}`)).body as AdminDashboard;
    expect(body.orders.unfilled).toBe(4);
  });

  it('refuses a range longer than ninety days', async () => {
    const from = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    expect((await dashboard(`?from=${from}`)).status).toBe(422);
  });
});
