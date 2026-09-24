import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrderTranscript,
  AdminPhoneReveal,
  AdminRole,
  CursorPage,
  OrderStatus,
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
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Order oversight and the dispute queue (issue #245, `admin-flow.md` § 3–4,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 5–6).
 */
describe('admin order oversight (issue #245)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let serviceId: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let counter = 0;

  interface SeededOrder {
    readonly orderId: string;
    readonly customerPhone: string;
    readonly masterPhone: string;
    readonly masterId: string;
  }

  async function adminToken(roles: readonly AdminRole[]): Promise<{ id: string; token: string }> {
    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Nigar',
      roles,
    });
    return {
      id: created.id,
      token: (await app.get(AdminSessionService).start(created.id)).accessToken,
    };
  }

  function call(method: 'get' | 'post', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`);
  }

  async function one<T>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await pool.query<T & object>(sql, params);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`No row from: ${sql}`);
    }
    return row;
  }

  function nextPhone(): string {
    counter += 1;
    return `+99450${String(counter).padStart(7, '0')}`;
  }

  /** An order in `status`, with a master, created `ageMinutes` ago. */
  async function seedOrder(status: OrderStatus, ageMinutes = 0): Promise<SeededOrder> {
    const customerPhone = nextPhone();
    const masterPhone = nextPhone();
    const customerUser = await one<{ id: string }>(
      `insert into users (id, phone_e164, status) values (gen_random_uuid(), $1, 'active') returning id`,
      [customerPhone],
    );
    const masterUser = await one<{ id: string }>(
      `insert into users (id, phone_e164, status) values (gen_random_uuid(), $1, 'active') returning id`,
      [masterPhone],
    );
    const customer = await one<{ id: string }>(
      `insert into customers (id, user_id, display_name) values (gen_random_uuid(), $1, 'Aygün') returning id`,
      [customerUser.id],
    );
    const master = await one<{ id: string }>(
      `insert into masters (id, user_id, display_name) values (gen_random_uuid(), $1, 'Rəşad') returning id`,
      [masterUser.id],
    );
    const address = await one<{ id: string }>(
      `insert into addresses (id, customer_id, formatted_address, apartment, position)
       values (gen_random_uuid(), $1, 'Bakı, Nizami küçəsi 1', '12',
               ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326)) returning id`,
      [customer.id],
    );
    const at = `now() - interval '${String(ageMinutes)} minutes'`;
    const order = await one<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status, description,
                           idempotency_key, accepted_at, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Kran sızır.', $6, now(), ${at}, ${at})
       returning id`,
      [customer.id, address.id, serviceId, master.id, status, `key-${randomUUID()}`],
    );
    return { orderId: order.id, customerPhone, masterPhone, masterId: master.id };
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
    serviceId = (await one<{ id: string }>(`select id from services order by id limit 1`, [])).id;
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

  describe('the list', () => {
    it('filters by status and finds stuck orders', async () => {
      const support = await adminToken(['support']);
      const fresh = await seedOrder('MASTER_ON_THE_WAY');
      const stuck = await seedOrder('MASTER_ON_THE_WAY', 180);

      const onTheWay = (
        await call('get', '/admin/orders?status=MASTER_ON_THE_WAY&limit=100', support.token)
      ).body as CursorPage<AdminOrderSummary>;
      const ids = onTheWay.items.map((item) => item.id);
      expect(ids).toContain(fresh.orderId);
      expect(ids).toContain(stuck.orderId);
      expect(onTheWay.items.every((item) => item.status === 'MASTER_ON_THE_WAY')).toBe(true);

      const stuckOnly = (await call('get', '/admin/orders?stuck=true&limit=100', support.token))
        .body as CursorPage<AdminOrderSummary>;
      const stuckIds = stuckOnly.items.map((item) => item.id);
      expect(stuckIds).toContain(stuck.orderId);
      expect(stuckIds).not.toContain(fresh.orderId);
    });

    it('queues disputes oldest first', async () => {
      const finance = await adminToken(['finance']);
      const older = await seedOrder('DISPUTED', 60);
      const newer = await seedOrder('DISPUTED', 5);
      const queue = (await call('get', '/admin/orders/disputes?limit=100', finance.token))
        .body as CursorPage<AdminOrderSummary>;
      const ids = queue.items.map((item) => item.id);
      expect(ids.indexOf(older.orderId)).toBeLessThan(ids.indexOf(newer.orderId));
      expect(queue.items.every((item) => item.status === 'DISPUTED')).toBe(true);
    });

    it('refuses an unknown status', async () => {
      const support = await adminToken(['support']);
      expect((await call('get', '/admin/orders?status=LOST', support.token)).status).toBe(422);
    });
  });

  describe('the detail', () => {
    it('shows parties with masked numbers, and is audited', async () => {
      const moderator = await adminToken(['moderator']);
      const order = await seedOrder('DISPUTED');
      const res = await call('get', `/admin/orders/${order.orderId}`, moderator.token);
      expect(res.status).toBe(200);
      const detail = res.body as AdminOrderDetail;
      expect(detail.customer.phoneMasked).toBe(`+994 •• ••• •• ${order.customerPhone.slice(-2)}`);
      expect(JSON.stringify(detail)).not.toContain(order.customerPhone);
      expect(detail.address.apartment).toBe('12');
      expect(detail.transitions).toEqual([
        { to: 'RESOLVED', available: true },
        { to: 'REFUNDED', available: false },
      ]);
      expect(detail.transcriptAvailable).toBe(true);

      const audit = await pool.query(
        `select 1 from admin_audit_log where admin_user_id = $1 and action = 'order.read' and target_id = $2`,
        [moderator.id, order.orderId],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('answers 404 for an order that does not exist', async () => {
      const support = await adminToken(['support']);
      expect((await call('get', `/admin/orders/${randomUUID()}`, support.token)).status).toBe(404);
    });
  });

  describe('revealing a phone number', () => {
    it('needs pii.read and a reason, and records the reason', async () => {
      const support = await adminToken(['support']);
      const moderator = await adminToken(['moderator']);
      const order = await seedOrder('ACCEPTED');
      const path = `/admin/orders/${order.orderId}/parties/master/phone`;

      expect((await call('post', path, moderator.token).send({ reason: 'Zəng' })).status).toBe(403);
      expect((await call('post', path, support.token).send({})).status).toBe(422);

      const res = await call('post', path, support.token).send({ reason: 'Usta cavab vermir.' });
      expect(res.status).toBe(200);
      expect((res.body as AdminPhoneReveal).phoneE164).toBe(order.masterPhone);

      const audit = await pool.query<{ reason: string }>(
        `select reason from admin_audit_log where action = 'order.master.phone.read' and target_id = $1`,
        [order.orderId],
      );
      expect(audit.rows).toEqual([{ reason: 'Usta cavab vermir.' }]);
    });
  });

  describe('the transcript', () => {
    it('is refused for an order that is not disputed', async () => {
      const support = await adminToken(['support']);
      const order = await seedOrder('ACCEPTED');
      const res = await call('get', `/admin/orders/${order.orderId}/transcript`, support.token);
      expect(res.status).toBe(409);
    });

    it('returns every conversation, oldest message first, and is audited', async () => {
      const support = await adminToken(['support']);
      const order = await seedOrder('DISPUTED');
      const conversation = await one<{ id: string }>(
        `insert into conversations (id, order_id, master_id) values (gen_random_uuid(), $1, $2) returning id`,
        [order.orderId, order.masterId],
      );
      await pool.query(
        `insert into messages (id, conversation_id, sender_kind, body, created_at) values
           (gen_random_uuid(), $1, 'customer', 'Salam', now() - interval '2 minutes'),
           (gen_random_uuid(), $1, 'master', 'Gəlirəm', now() - interval '1 minute')`,
        [conversation.id],
      );

      const res = await call('get', `/admin/orders/${order.orderId}/transcript`, support.token);
      expect(res.status).toBe(200);
      const transcript = res.body as AdminOrderTranscript;
      expect(transcript.conversations).toHaveLength(1);
      expect(transcript.conversations[0]?.messages.map((m) => m.body)).toEqual([
        'Salam',
        'Gəlirəm',
      ]);

      const audit = await pool.query(
        `select 1 from admin_audit_log where action = 'order.transcript.read' and target_id = $1`,
        [order.orderId],
      );
      expect(audit.rowCount).toBe(1);
    });
  });

  describe('dispute outcomes', () => {
    it('refuses REFUNDED until EPIC 12 and resolves with a reason', async () => {
      const finance = await adminToken(['finance']);
      const order = await seedOrder('DISPUTED');
      const path = `/admin/orders/${order.orderId}/transitions`;

      const refund = await call('post', path, finance.token).send({
        to: 'REFUNDED',
        reason: 'Pul qaytarılsın.',
      });
      expect(refund.status).toBe(409);
      expect((refund.body as ErrorEnvelope).error.code).toBe('REFUND_NOT_AVAILABLE');

      const resolve = await call('post', path, finance.token).send({
        to: 'RESOLVED',
        reason: 'Usta işi yenidən gördü.',
      });
      expect(resolve.status).toBe(200);
      const history = await pool.query<{ to_status: string; reason: string }>(
        `select to_status, reason from order_status_history where order_id = $1`,
        [order.orderId],
      );
      expect(history.rows).toEqual([{ to_status: 'RESOLVED', reason: 'Usta işi yenidən gördü.' }]);
    });
  });
});
