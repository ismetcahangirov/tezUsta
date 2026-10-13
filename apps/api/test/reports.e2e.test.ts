import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminDashboard,
  AdminReportDetail,
  AdminReportSummary,
  AdminRole,
  CursorPage,
  OrderStatus,
  OwnReport,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { loadAppConfig } from '../src/infra/config/load-app-config';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { createRateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Reports about a party (#330, ADR-0053), over real HTTP and a real database:
 * who may report whom and when, one report per side, editing until an admin
 * claims it, the admin queue's permission matrix, claim and close, the audit
 * rows, the dashboard's repeat-offender count, and the rate limit.
 */
describe('party reports (#330)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let serviceId: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let counter = 0;
  /** The per-user budget this suite runs with, so the limit is reachable. */
  const REPORTS_PER_USER = 4;

  interface Person {
    readonly userId: string;
    readonly token: string;
    readonly profileId: string;
  }

  async function one<T>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await pool.query<T & object>(sql, params);
    const row = rows[0];
    if (row === undefined) throw new Error(`No row from: ${sql}`);
    return row;
  }

  async function person(role: 'customer' | 'master', name = 'Aygün'): Promise<Person> {
    counter += 1;
    const created = await app.get(UsersRepository).create({
      phoneE164: `+99477${String(counter).padStart(7, '0')}`,
      roles: [role],
    });
    const table = role === 'customer' ? 'customers' : 'masters';
    const profile = await one<{ id: string }>(
      `insert into ${table} (id, user_id, display_name) values (gen_random_uuid(), $1, $2) returning id`,
      [created.user.id, name],
    );
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, token: pair.accessToken, profileId: profile.id };
  }

  /** An order between the two, in `status`; one that ended did so `endedHoursAgo` ago. */
  async function order(
    customer: Person,
    master: Person | null,
    status: OrderStatus,
    endedHoursAgo = 1,
  ): Promise<string> {
    const address = await one<{ id: string }>(
      `insert into addresses (id, customer_id, formatted_address, position)
       values (gen_random_uuid(), $1, 'Bakı', ST_SetSRID(ST_MakePoint(49.86, 40.40), 4326)) returning id`,
      [customer.profileId],
    );
    const created = await one<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status, description, idempotency_key)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Kran sızır.', $6) returning id`,
      [
        customer.profileId,
        address.id,
        serviceId,
        master?.profileId ?? null,
        status,
        `k-${randomUUID()}`,
      ],
    );
    await pool.query(
      `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
       values (gen_random_uuid(), $1, $2, $3, 'system', now() - make_interval(hours => $4))`,
      [
        created.id,
        status === 'IN_PROGRESS' ? 'MASTER_ARRIVED' : 'IN_PROGRESS',
        status,
        endedHoursAgo,
      ],
    );
    return created.id;
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

  function as(token: string) {
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(app.getHttpServer()).get(path)),
      post: (path: string) => auth(request(app.getHttpServer()).post(path)),
      put: (path: string) => auth(request(app.getHttpServer()).put(path)),
    };
  }

  function report(token: string, orderId: string, body: unknown = { reasonCode: 'no_show' }) {
    return as(token)
      .post(`/orders/${orderId}/reports`)
      .send(body as object);
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    process.env.DATABASE_URL = database.url;

    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `reports-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'report-submit': {
          ...real.policies['report-submit'],
          perIdentifier: REPORTS_PER_USER,
          perIp: 1_000_000,
        },
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(rateLimits)
      .compile();
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

  describe('who may report, and when (ADR-0053 § 1)', () => {
    it('lets the customer report the master on a completed order, and stores blank text as none', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');

      const res = await report(customer.token, orderId, { reasonCode: 'damage', text: '   ' });
      expect(res.status).toBe(201);
      expect(res.body as OwnReport).toMatchObject({
        orderId,
        reasonCode: 'damage',
        text: null,
        status: 'open',
        editable: true,
      });
      const stored = await one<{ reporter_role: string; master_id: string }>(
        `select reporter_role, master_id from reports where order_id = $1`,
        [orderId],
      );
      expect(stored).toEqual({ reporter_role: 'customer', master_id: master.profileId });
    });

    it('lets the master report the customer while the job is on', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'IN_PROGRESS');
      expect((await report(master.token, orderId, { reasonCode: 'rude_or_abusive' })).status).toBe(
        201,
      );
    });

    it('answers 404 to anyone who is not a party, the same as for no order', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const stranger = await person('customer');
      const otherMaster = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');

      const strangerRes = await report(stranger.token, orderId);
      const masterRes = await report(otherMaster.token, orderId);
      const missing = await report(stranger.token, randomUUID());
      for (const res of [strangerRes, masterRes, missing]) {
        expect(res.status).toBe(404);
        expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      }
    });

    it('refuses a report when no master has taken the order', async () => {
      const customer = await person('customer');
      const orderId = await order(customer, null, 'SEARCHING');
      const res = await report(customer.token, orderId);
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('REPORT_NO_OTHER_PARTY');
    });

    it('accepts a report up to seven days after the order ended, and refuses one after', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const recent = await order(customer, master, 'CANCELLED', 7 * 24 - 1);
      const old = await order(customer, master, 'COMPLETED', 7 * 24 + 1);

      expect((await report(customer.token, recent)).status).toBe(201);
      const late = await report(customer.token, old);
      expect(late.status).toBe(409);
      expect((late.body as ErrorEnvelope).error.code).toBe('REPORT_WINDOW_CLOSED');
    });
  });

  describe('one report per side, editable until claimed (ADR-0053 § 3)', () => {
    it('refuses a second report, edits the first, and freezes it once claimed', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      const moderator = await adminToken(['moderator']);

      expect((await report(customer.token, orderId)).status).toBe(201);
      const again = await report(customer.token, orderId);
      expect(again.status).toBe(409);
      expect((again.body as ErrorEnvelope).error.code).toBe('REPORT_ALREADY_FILED');

      const edited = await as(customer.token)
        .put(`/orders/${orderId}/reports/mine`)
        .send({ reasonCode: 'other', text: 'Kəlmə ilə izah edirəm.' });
      expect(edited.status).toBe(200);
      expect((edited.body as OwnReport).reasonCode).toBe('other');

      const id = (
        await one<{ id: string }>(`select id from reports where order_id = $1`, [orderId])
      ).id;
      expect((await as(moderator.token).post(`/admin/reports/${id}/claim`).send({})).status).toBe(
        204,
      );

      const frozen = await as(customer.token)
        .put(`/orders/${orderId}/reports/mine`)
        .send({ reasonCode: 'no_show' });
      expect(frozen.status).toBe(409);
      expect((frozen.body as ErrorEnvelope).error.code).toBe('REPORT_NOT_EDITABLE');

      const mine = (await as(customer.token).get(`/orders/${orderId}/reports/mine`))
        .body as OwnReport;
      expect(mine).toMatchObject({
        status: 'in_review',
        editable: false,
        text: 'Kəlmə ilə izah edirəm.',
      });
    });

    it('shows the reported party nothing', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      await report(customer.token, orderId, { reasonCode: 'unsafe_behaviour', text: 'Gizli' });

      const res = await as(master.token).get(`/orders/${orderId}/reports/mine`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Gizli');
    });
  });

  describe('a re-dispatch makes a new pairing (ADR-0053 § 3)', () => {
    it('keeps the previous master’s report from the new master, and lets each side report the new one', async () => {
      const customer = await person('customer');
      const first = await person('master');
      const second = await person('master');
      const orderId = await order(customer, first, 'IN_PROGRESS');
      expect(
        (
          await report(first.token, orderId, {
            reasonCode: 'rude_or_abusive',
            text: 'Birinci usta',
          })
        ).status,
      ).toBe(201);
      expect((await report(customer.token, orderId, { reasonCode: 'no_show' })).status).toBe(201);

      // The first master gives the job up; the second accepts it.
      await pool.query(`update orders set master_id = $2, status = 'ACCEPTED' where id = $1`, [
        orderId,
        second.profileId,
      ]);

      const peek = await as(second.token).get(`/orders/${orderId}/reports/mine`);
      expect(peek.status).toBe(404);
      expect(JSON.stringify(peek.body)).not.toContain('Birinci usta');
      const overwrite = await as(second.token)
        .put(`/orders/${orderId}/reports/mine`)
        .send({ reasonCode: 'other', text: 'üstünə yazdım' });
      expect(overwrite.status).toBe(404);

      expect((await report(second.token, orderId, { reasonCode: 'damage' })).status).toBe(201);
      expect((await report(customer.token, orderId, { reasonCode: 'damage' })).status).toBe(201);

      const rows = await pool.query<{
        master_id: string;
        reporter_role: string;
        text: string | null;
      }>(
        `select master_id, reporter_role, text from reports where order_id = $1 order by created_at`,
        [orderId],
      );
      expect(rows.rows).toEqual([
        { master_id: first.profileId, reporter_role: 'master', text: 'Birinci usta' },
        { master_id: first.profileId, reporter_role: 'customer', text: null },
        { master_id: second.profileId, reporter_role: 'master', text: null },
        { master_id: second.profileId, reporter_role: 'customer', text: null },
      ]);
    });
  });

  describe('validation and the rate limit', () => {
    it('refuses an unknown reason, a long text and an extra field', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      for (const body of [
        { reasonCode: 'boring' },
        { reasonCode: 'other', text: 'x'.repeat(1001) },
        { reasonCode: 'other', reportedUserId: master.userId },
      ]) {
        expect((await report(customer.token, orderId, body)).status).toBe(422);
      }
    });

    it('limits how often one person files or edits', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderIds: string[] = [];
      for (let n = 0; n <= REPORTS_PER_USER; n += 1) {
        orderIds.push(await order(customer, master, 'COMPLETED'));
      }
      const statuses: number[] = [];
      for (const orderId of orderIds) {
        statuses.push((await report(customer.token, orderId)).status);
      }
      expect(statuses.slice(0, REPORTS_PER_USER).every((status) => status === 201)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('the admin queue', () => {
    it.each([
      ['support', 200, 204],
      ['moderator', 200, 204],
      ['super_admin', 200, 204],
      ['finance', 403, 403],
    ] as const)('%s', async (role, read, handle) => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      await report(customer.token, orderId);
      const id = (
        await one<{ id: string }>(`select id from reports where order_id = $1`, [orderId])
      ).id;
      const admin = await adminToken([role]);

      expect((await as(admin.token).get('/admin/reports')).status).toBe(read);
      expect((await as(admin.token).get(`/admin/reports/${id}`)).status).toBe(read);
      expect((await as(admin.token).post(`/admin/reports/${id}/claim`).send({})).status).toBe(
        handle,
      );
      expect(
        (
          await as(admin.token)
            .post(`/admin/reports/${id}/close`)
            .send({ outcome: 'no_action', reason: 'Yoxlandı.' })
        ).status,
      ).toBe(handle);
    });

    it('lists oldest first, then claims, reads and closes with an outcome, all audited', async () => {
      const customer = await person('customer', 'Leyla');
      const master = await person('master', 'Rəşad');
      const orderId = await order(customer, master, 'COMPLETED');
      await report(customer.token, orderId, {
        reasonCode: 'asked_off_platform_payment',
        text: 'Nağd istədi.',
      });
      const moderator = await adminToken(['moderator']);

      const queue = (await as(moderator.token).get('/admin/reports?status=open&limit=100'))
        .body as CursorPage<AdminReportSummary>;
      const row = queue.items.find((item) => item.orderId === orderId);
      expect(row).toMatchObject({
        status: 'open',
        reasonCode: 'asked_off_platform_payment',
        reporter: { role: 'customer', profileId: customer.profileId, displayName: 'Leyla' },
        reported: { role: 'master', profileId: master.profileId, displayName: 'Rəşad' },
      });
      const createdAts = queue.items.map((item) => item.createdAt);
      expect(createdAts).toEqual([...createdAts].sort());
      const id = row?.id ?? '';

      // Closing before claiming is refused with the status.
      const early = await as(moderator.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'no_action', reason: 'x' });
      expect(early.status).toBe(409);
      expect((early.body as ErrorEnvelope).error.details).toEqual({ status: 'open' });

      expect((await as(moderator.token).post(`/admin/reports/${id}/claim`).send({})).status).toBe(
        204,
      );
      const twice = await as(moderator.token).post(`/admin/reports/${id}/claim`).send({});
      expect((twice.body as ErrorEnvelope).error.details).toEqual({ status: 'in_review' });

      const detail = (await as(moderator.token).get(`/admin/reports/${id}`))
        .body as AdminReportDetail;
      expect(detail).toMatchObject({
        text: 'Nağd istədi.',
        status: 'in_review',
        handledBy: { id: moderator.id },
        reportsAboutReportedLast30Days: 1,
      });
      expect(detail.order.id).toBe(orderId);

      // A suspension outcome needs the suspension to exist.
      const notTaken = await as(moderator.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'master_suspended', reason: 'Bloklandı.' });
      expect((notTaken.body as ErrorEnvelope).error.code).toBe('REPORT_OUTCOME_NOT_TAKEN');
      const wrongSide = await as(moderator.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'customer_suspended', reason: 'Bloklandı.' });
      expect((wrongSide.body as ErrorEnvelope).error.code).toBe('REPORT_OUTCOME_NOT_TAKEN');

      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [master.profileId],
      );
      const closed = await as(moderator.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'master_suspended', reason: 'Bloklandı, nağd tələb edirdi.' });
      expect(closed.status).toBe(204);

      const audit = await pool.query<{ action: string; reason: string | null; after: unknown }>(
        `select action, reason, after from admin_audit_log where target_id = $1 order by created_at, id`,
        [id],
      );
      expect(audit.rows).toEqual([
        { action: 'report.claim', reason: null, after: { status: 'in_review' } },
        { action: 'report.read', reason: null, after: null },
        {
          action: 'report.close',
          reason: 'Bloklandı, nağd tələb edirdi.',
          after: { status: 'closed', outcome: 'master_suspended' },
        },
      ]);
    });

    it('names nobody on the dashboard for a role that may not read reports', async () => {
      const finance = await adminToken(['finance']);
      const dashboard = (await as(finance.token).get('/admin/dashboard')).body as AdminDashboard;
      expect(dashboard.reports).toBeNull();
    });

    it('answers a close on a report nobody claimed with its status, whatever the outcome', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      await report(customer.token, orderId);
      const id = (
        await one<{ id: string }>(`select id from reports where order_id = $1`, [orderId])
      ).id;
      const moderator = await adminToken(['moderator']);
      const res = await as(moderator.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'master_suspended', reason: 'x' });
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.details).toEqual({ status: 'open' });
    });

    it('keeps the admin who claimed it as the handler when a colleague closes it', async () => {
      const customer = await person('customer');
      const master = await person('master');
      const orderId = await order(customer, master, 'COMPLETED');
      await report(customer.token, orderId);
      const id = (
        await one<{ id: string }>(`select id from reports where order_id = $1`, [orderId])
      ).id;
      const claimer = await adminToken(['support']);
      const closer = await adminToken(['moderator']);
      await as(claimer.token).post(`/admin/reports/${id}/claim`).send({});
      await as(closer.token)
        .post(`/admin/reports/${id}/close`)
        .send({ outcome: 'no_action', reason: 'Yoxlandı.' });

      const stored = await one<{ handled_by_admin_id: string }>(
        `select handled_by_admin_id from reports where id = $1`,
        [id],
      );
      expect(stored.handled_by_admin_id).toBe(claimer.id);
      const closeAudit = await one<{ admin_user_id: string }>(
        `select admin_user_id from admin_audit_log where target_id = $1 and action = 'report.close'`,
        [id],
      );
      expect(closeAudit.admin_user_id).toBe(closer.id);
    });

    it('counts a person reported more than once on the dashboard', async () => {
      const master = await person('master', 'Təkrar Usta');
      for (let n = 0; n < 2; n += 1) {
        const customer = await person('customer');
        const orderId = await order(customer, master, 'COMPLETED');
        expect((await report(customer.token, orderId)).status).toBe(201);
      }
      const superAdmin = await adminToken(['super_admin']);
      const dashboard = (await as(superAdmin.token).get('/admin/dashboard')).body as AdminDashboard;
      expect(dashboard.reports?.open).toBeGreaterThanOrEqual(2);
      expect(dashboard.reports?.repeatReported).toContainEqual({
        role: 'master',
        profileId: master.profileId,
        displayName: 'Təkrar Usta',
        count: 2,
      });
    });
  });
});
