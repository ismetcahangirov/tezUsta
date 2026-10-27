import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminCustomerSuspension,
  AdminOrderSummary,
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
import type { Actor } from '../src/modules/auth/auth.types';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { InvalidAccessTokenError } from '../src/modules/auth/token.service';
import { InvalidOrderTransitionError } from '../src/modules/orders/order-lifecycle';
import { OrdersService } from '../src/modules/orders/orders.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Customer accounts in the admin panel (#328,
 * [ADR-0050](docs/decisions/ADR-0050-admin-customer-accounts.md)), over real
 * HTTP and a real database: the permission matrix, the search that will not
 * match part of a number, the audited reads, the suspension's one transaction,
 * the orders it cancels and the ones it leaves, and the race with a customer
 * creating an order at the same moment.
 */
describe('admin customer accounts (#328)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let serviceId: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let counter = 0;

  interface SeededCustomer {
    readonly customerId: string;
    readonly userId: string;
    readonly phone: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly sessionId: string;
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
    return `+99470${String(counter).padStart(7, '0')}`;
  }

  /** A signed-in customer, optionally with a master profile on the same account. */
  async function seedCustomer(
    displayName: string,
    options: { readonly alsoMaster?: boolean } = {},
  ): Promise<SeededCustomer> {
    const phone = nextPhone();
    const created = await app.get(UsersRepository).create({
      phoneE164: phone,
      roles: options.alsoMaster === true ? ['customer', 'master'] : ['customer'],
    });
    const customer = await one<{ id: string }>(
      `insert into customers (id, user_id, display_name) values (gen_random_uuid(), $1, $2) returning id`,
      [created.user.id, displayName],
    );
    if (options.alsoMaster === true) {
      await pool.query(
        `insert into masters (id, user_id, display_name) values (gen_random_uuid(), $1, 'Usta Elçin')`,
        [created.user.id],
      );
    }
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const session = await one<{ id: string }>(
      `select id from sessions where user_id = $1 order by created_at desc limit 1`,
      [created.user.id],
    );
    return {
      customerId: customer.id,
      userId: created.user.id,
      phone,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      sessionId: session.id,
    };
  }

  async function seedAddress(customerId: string, label: string | null): Promise<string> {
    const address = await one<{ id: string }>(
      `insert into addresses (id, customer_id, label, formatted_address, apartment, position)
       values (gen_random_uuid(), $1, $2, 'Bakı, Nizami küçəsi 1', '12',
               ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326)) returning id`,
      [customerId, label],
    );
    return address.id;
  }

  async function seedOrder(
    customerId: string,
    status: OrderStatus,
    ageMinutes = 0,
  ): Promise<string> {
    const addressId = await seedAddress(customerId, null);
    const at = `now() - interval '${String(ageMinutes)} minutes'`;
    const order = await one<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, status, description,
                           idempotency_key, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'Kran sızır.', $5, ${at}, ${at})
       returning id`,
      [customerId, addressId, serviceId, status, `key-${randomUUID()}`],
    );
    return order.id;
  }

  async function statusOf(userId: string): Promise<string> {
    return (await one<{ status: string }>(`select status from users where id = $1`, [userId]))
      .status;
  }

  async function orderStatus(orderId: string): Promise<string> {
    return (await one<{ status: string }>(`select status from orders where id = $1`, [orderId]))
      .status;
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

  describe('who may do what (ADR-0043 § 1, ADR-0050 § 1)', () => {
    it.each([
      // role, list/detail/orders, phone, suspend
      ['support', 200, 200, 403],
      ['moderator', 200, 403, 200],
      ['finance', 200, 403, 403],
      ['super_admin', 200, 200, 200],
    ] as const)('%s', async (role, read, phone, suspend) => {
      const admin = await adminToken([role]);
      const customer = await seedCustomer('Matris');
      const base = `/admin/customers/${customer.customerId}`;

      expect((await call('get', '/admin/customers', admin.token)).status).toBe(read);
      expect((await call('get', base, admin.token)).status).toBe(read);
      expect((await call('get', `${base}/orders`, admin.token)).status).toBe(read);
      expect(
        (await call('post', `${base}/phone`, admin.token).send({ reason: 'Zəng' })).status,
      ).toBe(phone);
      expect(
        (await call('post', `${base}/suspend`, admin.token).send({ reason: 'Saxta sifariş' }))
          .status,
      ).toBe(suspend);
      if (suspend === 200) {
        expect(
          (await call('post', `${base}/reinstate`, admin.token).send({ reason: 'Səhv' })).status,
        ).toBe(200);
      } else {
        expect(
          (await call('post', `${base}/reinstate`, admin.token).send({ reason: 'Səhv' })).status,
        ).toBe(403);
        expect(await statusOf(customer.userId)).toBe('active');
      }
    });

    it('refuses a consumer token on every customer route', async () => {
      const customer = await seedCustomer('Rəna');
      const res = await call('get', '/admin/customers', customer.accessToken);
      expect(res.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('refuses a malformed id, an unknown status, a long query and a missing or extra reason', async () => {
      const admin = await adminToken(['super_admin']);
      const customer = await seedCustomer('Validasiya');
      const base = `/admin/customers/${customer.customerId}`;

      expect((await call('get', '/admin/customers/not-a-uuid', admin.token)).status).toBe(422);
      expect((await call('get', '/admin/customers?status=lost', admin.token)).status).toBe(422);
      expect((await call('get', `/admin/customers?q=${'a'.repeat(81)}`, admin.token)).status).toBe(
        422,
      );
      expect((await call('post', `${base}/suspend`, admin.token).send({})).status).toBe(422);
      expect(
        (await call('post', `${base}/suspend`, admin.token).send({ reason: '   ' })).status,
      ).toBe(422);
      expect(
        (await call('post', `${base}/suspend`, admin.token).send({ reason: 'x', extra: 1 })).status,
      ).toBe(422);
      expect(await statusOf(customer.userId)).toBe('active');
    });

    it('answers 404 for an id that is not a customer, including a master profile id', async () => {
      const admin = await adminToken(['super_admin']);
      const both = await seedCustomer('İkili', { alsoMaster: true });
      const master = await one<{ id: string }>(`select id from masters where user_id = $1`, [
        both.userId,
      ]);
      const unknown = await call('get', `/admin/customers/${randomUUID()}`, admin.token);
      const masterId = await call('get', `/admin/customers/${master.id}`, admin.token);
      expect(unknown.status).toBe(404);
      expect(masterId.status).toBe(404);
      expect((masterId.body as ErrorEnvelope).error.code).toBe(
        (unknown.body as ErrorEnvelope).error.code,
      );
    });
  });

  describe('the list', () => {
    it('finds by a name prefix, case-insensitively, and masks the number', async () => {
      const admin = await adminToken(['support']);
      const tag = randomUUID().slice(0, 6);
      const customer = await seedCustomer(`Zülfiyyə ${tag}`);
      await seedCustomer(`Başqa ${tag}`);

      const page = (
        await call('get', `/admin/customers?q=${encodeURIComponent('zÜLFİ')}`, admin.token)
      ).body as CursorPage<AdminCustomerSummary>;
      const ids = page.items.map((item) => item.id);
      expect(ids).toContain(customer.customerId);
      expect(page.items.every((item) => item.displayName.startsWith('Zülfiyyə'))).toBe(true);
      const row = page.items.find((item) => item.id === customer.customerId);
      expect(row?.phoneMasked).toBe(`+994 •• ••• •• ${customer.phone.slice(-2)}`);
      expect(JSON.stringify(page)).not.toContain(customer.phone);
    });

    it('treats LIKE wildcards in the query as plain characters', async () => {
      const admin = await adminToken(['support']);
      await seedCustomer('Wildcard Test');
      const page = (await call('get', `/admin/customers?q=${encodeURIComponent('%')}`, admin.token))
        .body as CursorPage<AdminCustomerSummary>;
      expect(page.items).toEqual([]);
    });

    it('finds a whole phone number and an id, and nothing for part of a number', async () => {
      const admin = await adminToken(['support']);
      const customer = await seedCustomer('Telefon');

      const whole = (
        await call('get', `/admin/customers?q=${encodeURIComponent(customer.phone)}`, admin.token)
      ).body as CursorPage<AdminCustomerSummary>;
      expect(whole.items.map((item) => item.id)).toEqual([customer.customerId]);

      const byId = (await call('get', `/admin/customers?q=${customer.customerId}`, admin.token))
        .body as CursorPage<AdminCustomerSummary>;
      expect(byId.items.map((item) => item.id)).toEqual([customer.customerId]);

      for (const part of [customer.phone.slice(0, 9), customer.phone.slice(-7), '+99470']) {
        const partial = (
          await call('get', `/admin/customers?q=${encodeURIComponent(part)}`, admin.token)
        ).body as CursorPage<AdminCustomerSummary>;
        expect(partial.items).toEqual([]);
      }
    });

    it('filters by account status and carries the order count and the last order', async () => {
      const admin = await adminToken(['super_admin']);
      const tag = randomUUID().slice(0, 6);
      const customer = await seedCustomer(`Statuslu ${tag}`);
      await seedOrder(customer.customerId, 'COMPLETED', 120);
      const latest = await seedOrder(customer.customerId, 'CANCELLED', 10);
      await pool.query(`update users set status = 'suspended' where id = $1`, [customer.userId]);

      const suspended = (
        await call('get', `/admin/customers?status=suspended&q=Statuslu%20${tag}`, admin.token)
      ).body as CursorPage<AdminCustomerSummary>;
      expect(suspended.items).toHaveLength(1);
      const [row] = suspended.items;
      expect(row?.status).toBe('suspended');
      expect(row?.orderCount).toBe(2);
      const latestAt = await one<{ created_at: Date }>(
        `select created_at from orders where id = $1`,
        [latest],
      );
      expect(row?.lastOrderAt).toBe(latestAt.created_at.toISOString());

      const active = (
        await call('get', `/admin/customers?status=active&q=Statuslu%20${tag}`, admin.token)
      ).body as CursorPage<AdminCustomerSummary>;
      expect(active.items).toEqual([]);
    });

    it('pages newest first without repeating or skipping anyone', async () => {
      const admin = await adminToken(['support']);
      const tag = `Səhifə${randomUUID().slice(0, 6)}`;
      const seeded: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        seeded.push((await seedCustomer(`${tag} ${String(n)}`)).customerId);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string =
          `/admin/customers?limit=2&q=${encodeURIComponent(tag)}` +
          (cursor === null ? '' : `&cursor=${cursor}`);
        const page = (await call('get', query, admin.token))
          .body as CursorPage<AdminCustomerSummary>;
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual([...seeded].reverse());
    });

    it('is not audited — a list carries no personal data', async () => {
      const admin = await adminToken(['support']);
      await call('get', '/admin/customers', admin.token);
      await call('get', '/admin/customers?q=Aygun', admin.token);
      const audit = await pool.query(`select 1 from admin_audit_log where admin_user_id = $1`, [
        admin.id,
      ]);
      expect(audit.rowCount).toBe(0);
    });
  });

  describe('the search by a whole number, and deleted profiles', () => {
    it('audits a whole-number search that finds someone, against the customer found', async () => {
      const moderator = await adminToken(['moderator']);
      const customer = await seedCustomer('Axtarılan');
      await call(
        'get',
        `/admin/customers?q=${encodeURIComponent(customer.phone)}`,
        moderator.token,
      );
      await call(
        'get',
        `/admin/customers?q=${encodeURIComponent('+994709999999')}`,
        moderator.token,
      );
      const audit = await pool.query<{ target_id: string }>(
        `select target_id from admin_audit_log
         where admin_user_id = $1 and action = 'customer.phone.search'`,
        [moderator.id],
      );
      expect(audit.rows).toEqual([{ target_id: customer.customerId }]);
    });

    it('leaves out a customer profile that was deleted', async () => {
      const admin = await adminToken(['support']);
      const customer = await seedCustomer(`Silinmiş ${randomUUID().slice(0, 6)}`);
      await pool.query(`update customers set deleted_at = now() where id = $1`, [
        customer.customerId,
      ]);
      const page = (await call('get', `/admin/customers?q=${customer.customerId}`, admin.token))
        .body as CursorPage<AdminCustomerSummary>;
      expect(page.items).toEqual([]);
      expect(
        (await call('get', `/admin/customers/${customer.customerId}`, admin.token)).status,
      ).toBe(404);
    });
  });

  describe('the file', () => {
    it('shows counts, address labels only, the master profile, and is audited', async () => {
      const admin = await adminToken(['moderator']);
      const customer = await seedCustomer('Fayl', { alsoMaster: true });
      await seedAddress(customer.customerId, 'Ev');
      await seedOrder(customer.customerId, 'SEARCHING');
      await seedOrder(customer.customerId, 'COMPLETED');
      await seedOrder(customer.customerId, 'CANCELLED');
      // ADR-0068 § 3: only a late cancellation is counted; a free one is not.
      const late = await seedOrder(customer.customerId, 'CANCELLED');
      await pool.query(`update orders set cancellation_kind = 'late' where id = $1`, [late]);
      await seedOrder(customer.customerId, 'RESOLVED');
      await seedOrder(customer.customerId, 'NO_MASTER_FOUND');

      const res = await call('get', `/admin/customers/${customer.customerId}`, admin.token);
      expect(res.status).toBe(200);
      const detail = res.body as AdminCustomerDetail;
      expect(detail.orderCounts).toEqual({
        open: 1,
        completed: 1,
        cancelled: 2,
        disputed: 1,
        unfilled: 1,
        lateCancellations: 1,
      });
      expect(detail.orderCount).toBe(6);
      expect(detail.addresses).toContainEqual({ label: 'Ev', isDefault: false });
      expect(detail.masterProfile?.displayName).toBe('Usta Elçin');
      expect(detail.statusReason).toBeNull();
      // Home addresses: no street, no flat, no coordinates, and no number.
      const body = JSON.stringify(detail);
      for (const secret of ['Nizami', '49.8671', '40.4093', customer.phone]) {
        expect(body).not.toContain(secret);
      }

      const audit = await pool.query(
        `select 1 from admin_audit_log where admin_user_id = $1 and action = 'customer.read' and target_id = $2`,
        [admin.id, customer.customerId],
      );
      expect(audit.rowCount).toBe(1);
    });

    it("lists the customer's orders newest first, and only theirs", async () => {
      const admin = await adminToken(['finance']);
      const customer = await seedCustomer('Sifarişçi');
      const other = await seedCustomer('Başqası');
      const older = await seedOrder(customer.customerId, 'COMPLETED', 60);
      const newer = await seedOrder(customer.customerId, 'CANCELLED', 5);
      await seedOrder(other.customerId, 'COMPLETED');

      const page = (
        await call('get', `/admin/customers/${customer.customerId}/orders`, admin.token)
      ).body as CursorPage<AdminOrderSummary>;
      expect(page.items.map((item) => item.id)).toEqual([newer, older]);
    });

    it('reveals the number with a reason, audited as a personal-data read', async () => {
      const support = await adminToken(['support']);
      const customer = await seedCustomer('Nömrə');
      const path = `/admin/customers/${customer.customerId}/phone`;

      expect((await call('post', path, support.token).send({})).status).toBe(422);
      const res = await call('post', path, support.token).send({ reason: 'Müştəri zəng istədi.' });
      expect(res.status).toBe(200);
      expect((res.body as AdminPhoneReveal).phoneE164).toBe(customer.phone);

      const audit = await pool.query<{ reason: string }>(
        `select reason from admin_audit_log where action = 'customer.phone.read' and target_id = $1`,
        [customer.customerId],
      );
      expect(audit.rows).toEqual([{ reason: 'Müştəri zəng istədi.' }]);
    });
  });

  describe('suspending and reinstating', () => {
    it('stops the account, kills its sessions, cancels what searches and leaves what a master holds', async () => {
      const moderator = await adminToken(['moderator']);
      const customer = await seedCustomer('Bloklanan');
      const searching = await seedOrder(customer.customerId, 'SEARCHING');
      const accepted = await seedOrder(customer.customerId, 'ACCEPTED');
      const done = await seedOrder(customer.customerId, 'COMPLETED');

      // The customer can act before.
      expect((await call('get', '/orders', customer.accessToken)).status).toBe(200);

      const res = await call(
        'post',
        `/admin/customers/${customer.customerId}/suspend`,
        moderator.token,
      ).send({ reason: 'Saxta sifarişlər' });
      expect(res.status).toBe(200);
      const suspension = res.body as AdminCustomerSuspension;
      expect(suspension.customer.status).toBe('suspended');
      expect(suspension.cancelledOrderIds).toEqual([searching]);
      expect(suspension.followUpOrderIds).toEqual([accepted]);

      // The next request is refused, and the refresh token is dead.
      expect((await call('get', '/orders', customer.accessToken)).status).toBe(401);
      await expect(app.get(SessionsService).refresh(customer.refreshToken)).rejects.toThrow();
      const sessions = await pool.query<{ revoked_reason: string | null }>(
        `select revoked_reason from sessions where user_id = $1`,
        [customer.userId],
      );
      expect(sessions.rows.every((row) => row.revoked_reason === 'suspension')).toBe(true);

      // The searching order went through the state machine, as this admin.
      expect(await orderStatus(searching)).toBe('CANCELLED');
      const history = await one<{ actor_kind: string; actor_admin_id: string; reason: string }>(
        `select actor_kind, actor_admin_id, reason from order_status_history
         where order_id = $1 and to_status = 'CANCELLED'`,
        [searching],
      );
      expect(history).toEqual({
        actor_kind: 'admin',
        actor_admin_id: moderator.id,
        reason: 'customer_suspended',
      });
      expect(await orderStatus(accepted)).toBe('ACCEPTED');
      expect(await orderStatus(done)).toBe('COMPLETED');

      // Who, when and why.
      const audit = await one<{
        admin_user_id: string;
        reason: string;
        before: unknown;
        after: unknown;
      }>(
        `select admin_user_id, reason, before, after from admin_audit_log
         where action = 'customer.suspend' and target_id = $1`,
        [customer.customerId],
      );
      expect(audit).toEqual({
        admin_user_id: moderator.id,
        reason: 'Saxta sifarişlər',
        before: { status: 'active' },
        after: { status: 'suspended', searchingOrderIds: [searching], heldOrderIds: [accepted] },
      });

      // The file shows why.
      const detail = (await call('get', `/admin/customers/${customer.customerId}`, moderator.token))
        .body as AdminCustomerDetail;
      expect(detail.status).toBe('suspended');
      expect(detail.statusReason).toBe('Saxta sifarişlər');
      expect(detail.statusChangedAt).not.toBeNull();
    });

    it('answers 409 for an account already suspended, and writes nothing more', async () => {
      const moderator = await adminToken(['moderator']);
      const customer = await seedCustomer('İkiqat');
      const path = `/admin/customers/${customer.customerId}/suspend`;
      expect((await call('post', path, moderator.token).send({ reason: 'Bir' })).status).toBe(200);

      const again = await call('post', path, moderator.token).send({ reason: 'İki' });
      expect(again.status).toBe(409);
      expect((again.body as ErrorEnvelope).error.details).toEqual({ status: 'suspended' });
      const audit = await pool.query(
        `select 1 from admin_audit_log where action = 'customer.suspend' and target_id = $1`,
        [customer.customerId],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('reinstates sign-in, keeps cancelled orders cancelled, and refuses a second reinstate', async () => {
      const superAdmin = await adminToken(['super_admin']);
      const customer = await seedCustomer('Qayıdan');
      const searching = await seedOrder(customer.customerId, 'SEARCHING');
      const base = `/admin/customers/${customer.customerId}`;
      await call('post', `${base}/suspend`, superAdmin.token).send({ reason: 'Şikayət' });

      const res = await call('post', `${base}/reinstate`, superAdmin.token).send({
        reason: 'Yoxlandı, səhv idi.',
      });
      expect(res.status).toBe(200);
      expect((res.body as AdminCustomerSummary).status).toBe('active');
      expect(await orderStatus(searching)).toBe('CANCELLED');

      // Signing in again works: a new session can be opened and used.
      const pair = await app.get(SessionsService).startSession({ userId: customer.userId });
      expect((await call('get', '/orders', pair.accessToken)).status).toBe(200);

      const audit = await one<{ reason: string; before: unknown; after: unknown }>(
        `select reason, before, after from admin_audit_log
         where action = 'customer.reinstate' and target_id = $1`,
        [customer.customerId],
      );
      expect(audit).toEqual({
        reason: 'Yoxlandı, səhv idi.',
        before: { status: 'suspended' },
        after: { status: 'active' },
      });

      const again = await call('post', `${base}/reinstate`, superAdmin.token).send({
        reason: 'Yenə',
      });
      expect(again.status).toBe(409);
    });

    it('writes the status, the sessions and the audit row in one transaction', async () => {
      const superAdmin = await adminToken(['super_admin']);
      const customer = await seedCustomer('Atomik');
      // Make the audit insert fail, after the status and the sessions were written.
      await pool.query(`
        create or replace function fail_customer_suspend_audit() returns trigger as $$
        begin
          if new.action = 'customer.suspend' then
            raise exception 'audit write refused for the test';
          end if;
          return new;
        end $$ language plpgsql`);
      await pool.query(
        `create trigger fail_customer_suspend_audit before insert on admin_audit_log
         for each row execute function fail_customer_suspend_audit()`,
      );
      try {
        const res = await call(
          'post',
          `/admin/customers/${customer.customerId}/suspend`,
          superAdmin.token,
        ).send({ reason: 'Atomiklik' });
        expect(res.status).toBe(500);
      } finally {
        await pool.query(`drop trigger fail_customer_suspend_audit on admin_audit_log`);
        await pool.query(`drop function fail_customer_suspend_audit()`);
      }

      expect(await statusOf(customer.userId)).toBe('active');
      const live = await pool.query(
        `select 1 from sessions where user_id = $1 and revoked_at is null`,
        [customer.userId],
      );
      expect(live.rowCount).toBe(1);
    });
  });

  describe('a suspension never cancels an order a master holds', () => {
    it('refuses the cancel once the order has left SEARCHING', async () => {
      // The post-commit loop's write, for an order a master accepted in the
      // moment between the suspension's commit and the loop reaching it.
      const admin = await adminToken(['super_admin']);
      const customer = await seedCustomer('Qəbul edilmiş');
      const accepted = await seedOrder(customer.customerId, 'ACCEPTED');
      await expect(
        app.get(OrdersService).override(admin.id, accepted, {
          to: 'CANCELLED',
          reason: 'customer_suspended',
          onlyFrom: 'SEARCHING',
        }),
      ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
      expect(await orderStatus(accepted)).toBe('ACCEPTED');
    });
  });

  describe('the race with a customer creating an order', () => {
    /** Resolved before the suspension, as a request already past its guard holds it. */
    function actorOf(customer: SeededCustomer): Actor {
      return {
        userId: customer.userId,
        sessionId: customer.sessionId,
        roles: ['customer'],
        status: 'active',
      };
    }

    it('refuses a creation that was authorized before the suspension committed', async () => {
      const moderator = await adminToken(['moderator']);
      const customer = await seedCustomer('Yarış');
      const addressId = await seedAddress(customer.customerId, null);
      const actor = actorOf(customer);

      await call('post', `/admin/customers/${customer.customerId}/suspend`, moderator.token).send({
        reason: 'Yarış testi',
      });

      await expect(
        app.get(OrdersService).create(actor, {
          addressId,
          serviceId,
          description: 'Kran sızır.',
          idempotencyKey: `key-${randomUUID()}`,
        }),
      ).rejects.toBeInstanceOf(InvalidAccessTokenError);
      const written = await pool.query(`select 1 from orders where customer_id = $1`, [
        customer.customerId,
      ]);
      expect(written.rowCount).toBe(0);
    });

    it('cancels an order whose creation held the lock while the suspension waited for it', async () => {
      const moderator = await adminToken(['moderator']);
      const customer = await seedCustomer('Gözləyən');
      const addressId = await seedAddress(customer.customerId, null);

      // A creation mid-flight: it holds the customer's order lock and has
      // written a searching order it has not committed yet.
      const creation = await pool.connect();
      let orderId: string;
      try {
        await creation.query('begin');
        await creation.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `order-create:${customer.customerId}`,
        ]);
        const inserted = await creation.query<{ id: string }>(
          `insert into orders (id, customer_id, address_id, service_id, status, description, idempotency_key)
           values (gen_random_uuid(), $1, $2, $3, 'SEARCHING', 'Kran sızır.', $4) returning id`,
          [customer.customerId, addressId, serviceId, `key-${randomUUID()}`],
        );
        orderId = inserted.rows[0]?.id ?? '';

        const suspension = call(
          'post',
          `/admin/customers/${customer.customerId}/suspend`,
          moderator.token,
        )
          .send({ reason: 'Yarış testi' })
          .then((res) => res);

        // The suspension is blocked on the same lock before it reads anything.
        await expect
          .poll(
            async () =>
              (
                await pool.query(
                  `select 1 from pg_locks
                   where locktype = 'advisory' and not granted
                     and database = (select oid from pg_database where datname = current_database())`,
                )
              ).rowCount,
            { timeout: 10_000 },
          )
          .toBeGreaterThan(0);

        await creation.query('commit');
        const res = await suspension;
        expect(res.status).toBe(200);
        expect((res.body as AdminCustomerSuspension).cancelledOrderIds).toEqual([orderId]);
      } finally {
        creation.release();
      }
      expect(await orderStatus(orderId)).toBe('CANCELLED');
    }, 20_000);
  });
});
