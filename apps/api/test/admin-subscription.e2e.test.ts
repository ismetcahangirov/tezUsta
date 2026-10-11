import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminDashboard,
  AdminMasterSubscription,
  AdminMasterSummary,
  AdminRole,
  AdminSubscription,
  CursorPage,
  MasterSubscription,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

const DAY_MS = 86_400_000;
const ROLES: readonly AdminRole[] = ['support', 'moderator', 'finance', 'super_admin'];
const MANAGERS: readonly AdminRole[] = ['finance', 'super_admin'];

/**
 * The admin subscription surface (issue #324, ADR-0046 § 5): editing the one
 * offer, a master's subscription, the masters-list column and filter, and the
 * dashboard counters. Through the real `AppModule` and HTTP.
 *
 * The suite shares one database and runs top to bottom: the offer starts with
 * no prices, so the "purchases cannot open" and launch-price tests come first.
 */
describe('admin subscription management (issue #324)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let counter = 0;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tokens = new Map<AdminRole, { id: string; token: string }>();

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

  function as(role: AdminRole): string {
    const token = tokens.get(role);
    if (token === undefined) throw new Error(`No token for ${role}`);
    return token.token;
  }

  function call(method: 'get' | 'post' | 'put', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`);
  }

  async function seedMaster(verificationStatus = 'active'): Promise<string> {
    counter += 1;
    const { rows: users } = await pool.query<{ id: string }>(
      `insert into users (id, phone_e164) values (gen_random_uuid(), $1) returning id`,
      [`+99455${String(counter).padStart(7, '0')}`],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into masters (id, user_id, display_name, verification_status)
       values (gen_random_uuid(), $1, 'Rəşad', $2) returning id`,
      [users[0]?.id, verificationStatus],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('no master');
    return id;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from (${sql}) x`,
      params,
    );
    return Number(rows[0]?.n ?? '0');
  }

  async function lastAudit(action: string): Promise<{
    admin_user_id: string;
    target_type: string;
    target_id: string;
    reason: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }> {
    const { rows } = await pool.query(
      `select admin_user_id, target_type, target_id, reason, before, after
         from admin_audit_log where action = $1 order by created_at desc, id desc limit 1`,
      [action],
    );
    const row = rows[0] as Awaited<ReturnType<typeof lastAudit>> | undefined;
    if (row === undefined) throw new Error(`No audit row for ${action}`);
    return row;
  }

  function errorCode(body: unknown): string {
    return (body as ErrorEnvelope).error.code;
  }

  async function overview(): Promise<AdminSubscription> {
    const res = await call('get', '/admin/subscription', as('finance'));
    expect(res.status).toBe(200);
    return res.body as AdminSubscription;
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    await runSeed(database.url);
    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    for (const role of ROLES) {
      tokens.set(role, await adminToken([role]));
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

  describe('before any price exists', () => {
    it('shows the seeded offer: no prices, 14-day trial, 3 days of grace, purchases closed', async () => {
      const offer = await overview();
      expect(offer).toMatchObject({
        monthly: null,
        yearly: null,
        scheduled: { monthly: null, yearly: null },
        trialDays: 14,
        graceDays: 3,
        purchasesOpen: false,
        priceChangeNoticeDays: 30,
        noticeRequired: { monthly: false, yearly: false },
        priceHistory: [],
      });
    });

    it('refuses to open purchases while either period has no price', async () => {
      const res = await call('put', '/admin/subscription/settings', as('finance')).send({
        purchasesOpen: true,
        reason: 'Launch.',
      });
      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_PURCHASES_NEED_PRICES');
      expect((await overview()).purchasesOpen).toBe(false);
    });
  });

  describe('validation', () => {
    it.each([
      ['a negative price', { monthlyMinor: -100 }],
      ['a zero price', { monthlyMinor: 0 }],
      ['a fractional price', { monthlyMinor: 12.5 }],
      ['an absurd price', { monthlyMinor: 10_000_001 }],
      ['no price at all', {}],
      ['an unknown field', { monthlyMinor: 2000, plan: 'gold' }],
      ['a date that is not ISO-8601', { monthlyMinor: 2000, effectiveFrom: 'tomorrow' }],
    ])('refuses %s with 422', async (_label, body) => {
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        ...body,
        reason: 'Testing.',
      });
      expect(res.status).toBe(422);
    });

    it('refuses a price change with no reason', async () => {
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 2000,
      });
      expect(res.status).toBe(422);
    });

    it('refuses an effectiveFrom in the past or more than a year ahead', async () => {
      for (const at of [Date.now() - DAY_MS, Date.now() + 400 * DAY_MS]) {
        const res = await call('put', '/admin/subscription/prices', as('finance')).send({
          monthlyMinor: 2000,
          effectiveFrom: new Date(at).toISOString(),
          reason: 'Testing.',
        });
        expect(res.status).toBe(422);
        expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID');
      }
    });

    it.each([
      ['a trial over 90 days', { trialDays: 91 }],
      ['a negative trial', { trialDays: -1 }],
      ['grace over 30 days', { graceDays: 31 }],
      ['no setting at all', {}],
    ])('refuses settings with %s', async (_label, body) => {
      const res = await call('put', '/admin/subscription/settings', as('finance')).send({
        ...body,
        reason: 'Testing.',
      });
      expect(res.status).toBe(422);
    });

    it.each([0, 367, 1.5])('refuses a grant of %s days', async (days) => {
      const masterId = await seedMaster();
      const res = await call(
        'post',
        `/admin/masters/${masterId}/subscription/grant`,
        as('finance'),
      ).send({ days, reason: 'Testing.' });
      expect(res.status).toBe(422);
    });

    it('writes nothing for a refused request', async () => {
      expect(await count('select 1 from subscription_prices')).toBe(0);
      expect(await count(`select 1 from admin_audit_log where action like 'subscription.%'`)).toBe(
        0,
      );
    });
  });

  describe('setting the launch prices', () => {
    it('asks to confirm a first price that is unusually high — the 1000-for-10.00 typo', async () => {
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 150_000,
        reason: 'Launch price.',
      });
      expect(res.status).toBe(422);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED');
    });

    it('applies launch prices at once, since nobody has paid yet, and audits them with the reason', async () => {
      const finance = tokens.get('finance');
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 2_000,
        yearlyMinor: 20_000,
        reason: 'Launch prices from the owner.',
      });

      expect(res.status).toBe(200);
      const offer = res.body as AdminSubscription;
      expect(offer.monthly).toMatchObject({ priceMinor: 2_000, currency: 'AZN' });
      expect(offer.yearly).toMatchObject({ priceMinor: 20_000 });
      expect(offer.priceHistory.map((row) => row.state)).toEqual(['current', 'current']);

      const audit = await lastAudit('subscription.prices.change');
      expect(audit).toMatchObject({
        admin_user_id: finance?.id,
        target_type: 'subscription',
        reason: 'Launch prices from the owner.',
        before: { monthly: { priceMinor: null }, yearly: { priceMinor: null } },
        after: { monthly: { priceMinor: 2_000 }, yearly: { priceMinor: 20_000 } },
      });
    });

    it('opens purchases once both periods have a price, audited before and after', async () => {
      const res = await call('put', '/admin/subscription/settings', as('finance')).send({
        purchasesOpen: true,
        trialDays: 30,
        reason: 'Opening sales with a longer launch trial.',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ purchasesOpen: true, trialDays: 30, graceDays: 3 });
      expect(await lastAudit('subscription.settings.change')).toMatchObject({
        before: { trialDays: 14, graceDays: 3, purchasesOpen: false },
        after: { trialDays: 30, graceDays: 3, purchasesOpen: true },
      });
    });

    it('applies a trial change to trials started from then on', async () => {
      const masterId = await seedMaster();
      await app.get(SubscriptionsService).startTrial(masterId);
      const res = await call('get', `/admin/masters/${masterId}/subscription`, as('support'));
      const subscription = (res.body as AdminMasterSubscription).subscription;
      const length =
        new Date(subscription?.currentPeriodEnd ?? 0).getTime() -
        new Date(subscription?.currentPeriodStart ?? 0).getTime();
      expect(length).toBe(30 * DAY_MS);
    });
  });

  describe('changing a price someone has paid for', () => {
    let paidMaster: string;

    beforeAll(async () => {
      paidMaster = await seedMaster();
      const offer = await overview();
      const monthly = offer.priceHistory.find(
        (row) => row.billingPeriod === 'monthly' && row.state === 'current',
      );
      await app.get(SubscriptionsService).activatePeriod({
        masterId: paidMaster,
        billingPeriod: 'monthly',
        priceId: monthly?.id ?? '',
        paymentRef: `pay-${randomUUID()}`,
      });
    });

    it('needs the 30-day notice, and says from when', async () => {
      expect((await overview()).noticeRequired).toEqual({ monthly: true, yearly: false });
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 2_500,
        effectiveFrom: new Date(Date.now() + 5 * DAY_MS).toISOString(),
        reason: 'Raising the price.',
      });
      expect(res.status).toBe(422);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_NOTICE_REQUIRED');
      expect((res.body as ErrorEnvelope).error.details?.earliestEffectiveFrom).toEqual(
        expect.any(String),
      );
    });

    it('asks to confirm a price that doubles', async () => {
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 4_000,
        reason: 'Raising the price.',
      });
      expect(res.status).toBe(422);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED');
    });

    it('schedules the change at the end of the notice by default; the paid period keeps its price', async () => {
      const before = Date.now();
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 2_500,
        reason: 'Raising the price.',
      });

      expect(res.status).toBe(200);
      const offer = res.body as AdminSubscription;
      expect(offer.monthly?.priceMinor).toBe(2_000);
      const scheduledAt = new Date(offer.scheduled.monthly?.effectiveFrom ?? 0).getTime();
      expect(scheduledAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 1_000);
      expect(offer.scheduled.monthly?.priceMinor).toBe(2_500);

      const history = await call('get', `/admin/masters/${paidMaster}/subscription`, as('support'));
      const paid = (history.body as AdminMasterSubscription).events.find(
        (event) => event.kind === 'period_activated',
      );
      expect(paid?.amountMinor).toBe(2_000);
    });

    it('refuses a second scheduled price for the same period', async () => {
      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        monthlyMinor: 2_600,
        reason: 'Changed our mind.',
      });
      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_ALREADY_SCHEDULED');
    });
  });

  describe('scheduling and withdrawing a price', () => {
    it('schedules a yearly price for next month and withdraws it, and the history keeps both', async () => {
      const nextMonth = new Date(Date.now() + 31 * DAY_MS).toISOString();
      const scheduled = await call('put', '/admin/subscription/prices', as('finance')).send({
        yearlyMinor: 22_000,
        effectiveFrom: nextMonth,
        reason: 'Yearly price for the new season.',
      });
      expect(scheduled.status).toBe(200);
      const priceId = (scheduled.body as AdminSubscription).scheduled.yearly?.id ?? '';
      const rowsBefore = await pool.query('select * from subscription_prices order by id');

      const withdrawn = await call(
        'post',
        `/admin/subscription/prices/${priceId}/withdraw`,
        as('finance'),
      ).send({ reason: 'Entered too early.' });

      expect(withdrawn.status).toBe(200);
      const offer = withdrawn.body as AdminSubscription;
      expect(offer.scheduled.yearly).toBeNull();
      expect(offer.yearly?.priceMinor).toBe(20_000);
      expect(offer.priceHistory.find((row) => row.id === priceId)?.state).toBe('withdrawn');
      expect(offer.priceHistory[0]).toMatchObject({
        state: 'withdrawal',
        withdrawsPriceId: priceId,
      });
      expect(await lastAudit('subscription.prices.withdraw')).toMatchObject({
        reason: 'Entered too early.',
        after: { yearly: { scheduled: null } },
      });

      // No row was changed in place: every earlier row is exactly as it was.
      const rowsAfter = await pool.query('select * from subscription_prices order by id');
      for (const row of rowsBefore.rows) {
        expect(rowsAfter.rows).toContainEqual(row);
      }
      expect(rowsAfter.rows).toHaveLength(rowsBefore.rows.length + 1);
    });

    it('refuses to withdraw a price twice, or one already in effect', async () => {
      const offer = await overview();
      const withdrawn = offer.priceHistory.find((row) => row.state === 'withdrawn');
      const current = offer.priceHistory.find((row) => row.state === 'current');
      for (const id of [withdrawn?.id, current?.id]) {
        const res = await call(
          'post',
          `/admin/subscription/prices/${id ?? ''}/withdraw`,
          as('finance'),
        ).send({ reason: 'Again.' });
        expect(res.status).toBe(409);
        expect(errorCode(res.body)).toBe('SUBSCRIPTION_PRICE_NOT_SCHEDULED');
      }
    });
  });

  describe("one master's subscription", () => {
    it('grants a verified master with no subscription 30 days, and they become entitled to work', async () => {
      const masterId = await seedMaster();
      expect(await app.get(SubscriptionsService).isEntitled(masterId)).toBe(false);

      const res = await call(
        'post',
        `/admin/masters/${masterId}/subscription/grant`,
        as('finance'),
      ).send({ days: 30, reason: 'Paid cash at the office.' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'active', billingPeriod: null, entitled: true });
      expect(await app.get(SubscriptionsService).isEntitled(masterId)).toBe(true);
      expect(await lastAudit('subscription.grant')).toMatchObject({
        target_type: 'master',
        target_id: masterId,
        reason: 'Paid cash at the office.',
        before: { status: null },
        after: { status: 'active' },
      });

      const view = await call('get', `/admin/masters/${masterId}/subscription`, as('moderator'));
      expect((view.body as AdminMasterSubscription).events[0]).toMatchObject({
        kind: 'period_granted',
        reason: 'Paid cash at the office.',
      });
    });

    it('cancels a running period, which runs to its end, and refuses to cancel a trial', async () => {
      const active = await seedMaster();
      await call('post', `/admin/masters/${active}/subscription/grant`, as('finance')).send({
        days: 10,
        reason: 'Compensation.',
      });
      const res = await call(
        'post',
        `/admin/masters/${active}/subscription/cancel`,
        as('finance'),
      ).send({ reason: 'The master asked to stop.' });
      expect(res.status).toBe(200);
      expect(res.body as MasterSubscription).toMatchObject({ status: 'cancelled', entitled: true });
      expect(await lastAudit('subscription.cancel')).toMatchObject({
        target_id: active,
        reason: 'The master asked to stop.',
      });

      const trialing = await seedMaster();
      await app.get(SubscriptionsService).startTrial(trialing);
      const refused = await call(
        'post',
        `/admin/masters/${trialing}/subscription/cancel`,
        as('finance'),
      ).send({ reason: 'Testing.' });
      expect(refused.status).toBe(409);
      expect(errorCode(refused.body)).toBe('SUBSCRIPTION_TRANSITION_NOT_ALLOWED');
    });

    it('refuses a grant before approval, so the trial still starts when verification approves', async () => {
      const pending = await seedMaster('pending_verification');

      const res = await call(
        'post',
        `/admin/masters/${pending}/subscription/grant`,
        as('finance'),
      ).send({ days: 30, reason: 'Launch promotion.' });

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('SUBSCRIPTION_TRANSITION_NOT_ALLOWED');
      expect(
        await count('select 1 from master_subscriptions where master_id = $1', [pending]),
      ).toBe(0);
      await pool.query(`update masters set verification_status = 'active' where id = $1`, [
        pending,
      ]);
      expect(await app.get(SubscriptionsService).startTrial(pending)).toBe(true);
    });

    it('grants a suspended master days in compensation', async () => {
      const suspended = await seedMaster();
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [suspended],
      );
      const res = await call(
        'post',
        `/admin/masters/${suspended}/subscription/grant`,
        as('finance'),
      ).send({ days: 7, reason: 'Suspended in error.' });
      expect(res.status).toBe(200);
    });

    it('lets finance open the masters list and a master’s file, where grants are made', async () => {
      const masterId = await seedMaster();
      expect((await call('get', '/admin/masters', as('finance'))).status).toBe(200);
      expect((await call('get', `/admin/masters/${masterId}`, as('finance'))).status).toBe(200);
    });

    it('answers a master with no subscription with null and no events', async () => {
      const masterId = await seedMaster('pending_verification');
      const res = await call('get', `/admin/masters/${masterId}/subscription`, as('support'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ subscription: null, events: [] });
    });

    it('answers 404 for a master who does not exist', async () => {
      const ghost = randomUUID();
      expect(
        (await call('get', `/admin/masters/${ghost}/subscription`, as('finance'))).status,
      ).toBe(404);
      expect(
        (
          await call('post', `/admin/masters/${ghost}/subscription/grant`, as('finance')).send({
            days: 5,
            reason: 'Testing.',
          })
        ).status,
      ).toBe(404);
    });
  });

  describe('the audit row is in the same transaction', () => {
    it('leaves neither a price nor an audit row when the audit write fails', async () => {
      const prices = await count('select 1 from subscription_prices');
      const audits = await count(
        `select 1 from admin_audit_log where action like 'subscription.%'`,
      );
      const spy = vi
        .spyOn(app.get(AdminRepository), 'appendAudit')
        .mockRejectedValueOnce(new Error('audit store unavailable'));

      const res = await call('put', '/admin/subscription/prices', as('finance')).send({
        yearlyMinor: 21_000,
        effectiveFrom: new Date(Date.now() + 40 * DAY_MS).toISOString(),
        reason: 'Will fail.',
      });

      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(await count('select 1 from subscription_prices')).toBe(prices);
      expect(await count(`select 1 from admin_audit_log where action like 'subscription.%'`)).toBe(
        audits,
      );
    });

    it('leaves neither a grant nor an audit row when the audit write fails', async () => {
      const masterId = await seedMaster();
      const spy = vi
        .spyOn(app.get(AdminRepository), 'appendAudit')
        .mockRejectedValueOnce(new Error('audit store unavailable'));

      const res = await call(
        'post',
        `/admin/masters/${masterId}/subscription/grant`,
        as('finance'),
      ).send({ days: 30, reason: 'Will fail.' });

      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(
        await count('select 1 from master_subscriptions where master_id = $1', [masterId]),
      ).toBe(0);
    });
  });

  describe('the masters list and the dashboard', () => {
    it('shows each master’s subscription status and filters by it', async () => {
      const none = await seedMaster('pending_verification');
      const trialing = await seedMaster();
      await app.get(SubscriptionsService).startTrial(trialing);

      const all = await call('get', '/admin/masters?limit=100', as('support'));
      const items = (all.body as CursorPage<AdminMasterSummary>).items;
      expect(items.find((row) => row.id === none)?.subscriptionStatus).toBeNull();
      expect(items.find((row) => row.id === trialing)?.subscriptionStatus).toBe('trialing');

      const filtered = await call(
        'get',
        '/admin/masters?subscriptionStatus=trialing&limit=100',
        as('support'),
      );
      const ids = (filtered.body as CursorPage<AdminMasterSummary>).items.map((row) => row.id);
      expect(ids).toContain(trialing);
      expect(ids).not.toContain(none);
      expect(
        (filtered.body as CursorPage<AdminMasterSummary>).items.every(
          (row) => row.subscriptionStatus === 'trialing',
        ),
      ).toBe(true);

      const withNone = await call(
        'get',
        '/admin/masters?subscriptionStatus=none&limit=100',
        as('support'),
      );
      expect(
        (withNone.body as CursorPage<AdminMasterSummary>).items.map((row) => row.id),
      ).toContain(none);
    });

    it('counts subscriptions on the dashboard', async () => {
      const read = async () =>
        ((await call('get', '/admin/dashboard', as('support'))).body as AdminDashboard)
          .subscriptions;
      const before = await read();
      const masterId = await seedMaster();
      await app.get(SubscriptionsService).startTrial(masterId);

      const after = await read();
      expect(after.trialing).toBe(before.trialing + 1);
      expect(after).toEqual({
        trialing: expect.any(Number),
        activeMonthly: expect.any(Number),
        activeYearly: expect.any(Number),
        activeGranted: expect.any(Number),
        inGrace: expect.any(Number),
        expiredLast7Days: expect.any(Number),
      });
      expect(after.activeMonthly).toBeGreaterThanOrEqual(1);
      expect(after.activeGranted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the permission matrix', () => {
    it.each(ROLES)('lets %s read the offer and a master’s subscription', async (role) => {
      const masterId = await seedMaster();
      expect((await call('get', '/admin/subscription', as(role))).status).toBe(200);
      expect((await call('get', `/admin/masters/${masterId}/subscription`, as(role))).status).toBe(
        200,
      );
    });

    it.each(ROLES)('gives %s every edit only if it manages subscriptions', async (role) => {
      const allowed = MANAGERS.includes(role);
      const masterId = await seedMaster();
      const edits = [
        () =>
          call('put', '/admin/subscription/settings', as(role)).send({
            graceDays: 3,
            reason: 'Matrix.',
          }),
        () =>
          call('post', `/admin/masters/${masterId}/subscription/grant`, as(role)).send({
            days: 3,
            reason: 'Matrix.',
          }),
        () =>
          call('post', `/admin/masters/${masterId}/subscription/cancel`, as(role)).send({
            reason: 'Matrix.',
          }),
      ];
      for (const edit of edits) {
        const res = await edit();
        if (allowed) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(403);
        }
      }

      const prices = await call('put', '/admin/subscription/prices', as(role)).send({
        monthlyMinor: 2_100,
        reason: 'Matrix.',
      });
      // A manager gets past the permission check to the business rule (a
      // monthly change is already scheduled); everyone else is stopped first.
      expect(prices.status).toBe(allowed ? 409 : 403);
      const withdraw = await call(
        'post',
        `/admin/subscription/prices/${randomUUID()}/withdraw`,
        as(role),
      ).send({ reason: 'Matrix.' });
      expect(withdraw.status).toBe(allowed ? 409 : 403);
    });

    it('needs an admin session at all', async () => {
      expect((await request(app.getHttpServer()).get('/admin/subscription')).status).toBe(401);
    });
  });
});
