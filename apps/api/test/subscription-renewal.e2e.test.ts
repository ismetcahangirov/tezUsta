import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  MasterSubscription,
  SubscriptionAutoRenewal,
  SubscriptionCheckout,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { BILLING_PROVIDER } from '../src/infra/billing/billing.types';
import type { StubBillingProvider, StubDelivery } from '../src/infra/billing/stub-billing.provider';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { SubscriptionRenewalService } from '../src/modules/billing/subscription-renewal.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Auto-renewal on a saved card over real HTTP and the real `AppModule`
 * (ADR-0046 § 6, ADR-0058, issue #323): consent at checkout, the card kept
 * from the verified webhook, one charge per period inside the lead window,
 * its outcome through the same webhook, and every reason not to charge.
 *
 * The renewal job is disabled for the suites (`setup-env.ts`); each test runs
 * one pass with `renewDue()`. A period is moved into the lead window with SQL
 * rather than by waiting a month.
 */

const MONTHLY_MINOR = 2_500;

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

interface SignedInMaster {
  readonly accessToken: string;
  readonly masterId: string;
}

describe('subscription auto-renewal (ADR-0058, issue #323)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessions: SessionsService;
  let stub: StubBillingProvider;
  let renewals: SubscriptionRenewalService;
  let subscriptions: SubscriptionsService;
  let adminId: string;

  async function signIn(): Promise<string> {
    const created = await usersRepo.create({ email: nextEmail(), roles: [] });
    return (await sessions.startSession({ userId: created.user.id })).accessToken;
  }

  async function signInAsMaster(): Promise<SignedInMaster> {
    const accessToken = await signIn();
    const res = await request(app.getHttpServer())
      .post('/masters')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ displayName: 'Usta Elçin' });
    expect(res.status).toBe(201);
    const masterId = (res.body as { id: string }).id;
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [masterId]);
    return { accessToken, masterId };
  }

  function deliver(delivery: StubDelivery) {
    return request(app.getHttpServer())
      .post('/webhooks/billing/stub')
      .set(delivery.headers)
      .send(delivery.body.toString('utf8'));
  }

  function autoRenewal(method: 'get' | 'delete', accessToken?: string) {
    const pending = request(app.getHttpServer())[method]('/masters/me/subscription/auto-renewal');
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function readSubscription(accessToken: string): Promise<MasterSubscription> {
    const res = await request(app.getHttpServer())
      .get('/masters/me/subscription')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    return res.body as MasterSubscription;
  }

  /** A master buys a monthly period at a hosted checkout, consenting or not, and the webhook lands. */
  async function buyMonthly(autoRenew: boolean): Promise<SignedInMaster> {
    const master = await signInAsMaster();
    const res = await request(app.getHttpServer())
      .post('/masters/me/subscription/checkout')
      .set('authorization', `Bearer ${master.accessToken}`)
      .send({ billingPeriod: 'monthly', autoRenew });
    expect(res.status).toBe(201);
    expect((res.body as SubscriptionCheckout).autoRenew).toBe(autoRenew);
    const { rows } = await pool.query<{ provider_ref: string }>(
      `select provider_ref from subscription_checkouts where master_id = $1`,
      [master.masterId],
    );
    expect((await deliver(stub.pay(rows[0]?.provider_ref ?? ''))).status).toBe(200);
    return master;
  }

  /** Moves the running period's end to `hours` from now, inside or outside the lead window. */
  async function endPeriodIn(masterId: string, hours: number): Promise<void> {
    await pool.query(
      `update master_subscriptions
          set current_period_end = now() + make_interval(hours => $2),
              current_period_start = now() - interval '29 days'
        where master_id = $1`,
      [masterId, hours],
    );
  }

  async function renewalsOf(
    masterId: string,
  ): Promise<{ provider_ref: string; amount_minor: string; price_id: string }[]> {
    const { rows } = await pool.query<{
      provider_ref: string;
      amount_minor: string;
      price_id: string;
    }>(
      `select provider_ref, amount_minor, price_id from subscription_checkouts
        where master_id = $1 and kind = 'renewal' order by created_at`,
      [masterId],
    );
    return rows;
  }

  async function insertPrice(minor: number): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into subscription_prices (id, billing_period, price_minor, effective_from, created_by_admin_id)
       values ($1, 'monthly', $2, now() - interval '1 second', $3)`,
      [id, minor, adminId],
    );
    return id;
  }

  async function withdraw(priceId: string): Promise<void> {
    await pool.query(
      `insert into subscription_prices (id, billing_period, price_minor, effective_from,
                                        created_by_admin_id, withdraws_price_id)
       values ($1, 'monthly', null, now(), $2, $3)`,
      [randomUUID(), adminId, priceId],
    );
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessions = app.get(SessionsService);
    stub = app.get<StubBillingProvider>(BILLING_PROVIDER);
    renewals = app.get(SubscriptionRenewalService);
    subscriptions = app.get(SubscriptionsService);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    adminId = randomUUID();
    await pool.query(
      `insert into admin_users (id, email, display_name) values ($1, 'renewal@tezusta.az', 'Admin')`,
      [adminId],
    );
    await insertPrice(MONTHLY_MINOR);
  }, 60_000);

  beforeEach(async () => {
    await pool.query('update subscription_settings set purchases_open = true where id = 1');
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

  describe('/masters/me/subscription/auto-renewal', () => {
    it('requires authentication, and a master', async () => {
      expect((await autoRenewal('get')).status).toBe(401);
      expect((await autoRenewal('delete')).status).toBe(401);
      const customer = await signIn();
      expect((await autoRenewal('get', customer)).status).toBe(403);
      expect((await autoRenewal('delete', customer)).status).toBe(403);
    });

    it('is on only for a master who asked for it at checkout', async () => {
      const consenting = await buyMonthly(true);
      const declining = await buyMonthly(false);

      expect((await autoRenewal('get', consenting.accessToken)).body).toEqual({
        enabled: true,
      } satisfies SubscriptionAutoRenewal);
      expect((await autoRenewal('get', declining.accessToken)).body).toEqual({ enabled: false });
    });

    it('turns off, idempotently, and the card is never charged again', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 2);

      expect((await autoRenewal('delete', master.accessToken)).status).toBe(204);
      expect((await autoRenewal('delete', master.accessToken)).status).toBe(204);
      expect((await autoRenewal('get', master.accessToken)).body).toEqual({ enabled: false });

      await renewals.renewDue();
      expect(await renewalsOf(master.masterId)).toEqual([]);
    });

    it('lets the latest purchase decide: paying without auto-renewal retires a card saved before (#424)', async () => {
      const master = await buyMonthly(true);
      // A second period, bought by hand with auto-renewal unticked.
      const res = await request(app.getHttpServer())
        .post('/masters/me/subscription/checkout')
        .set('authorization', `Bearer ${master.accessToken}`)
        .send({ billingPeriod: 'monthly', autoRenew: false });
      expect(res.status).toBe(201);
      const { rows } = await pool.query<{ provider_ref: string }>(
        `select provider_ref from subscription_checkouts where master_id = $1 order by created_at desc limit 1`,
        [master.masterId],
      );
      expect((await deliver(stub.pay(rows[0]?.provider_ref ?? ''))).status).toBe(200);

      expect((await autoRenewal('get', master.accessToken)).body).toEqual({ enabled: false });
    });

    it('keeps one live card when a newer one replaces it', async () => {
      const master = await buyMonthly(true);
      const res = await request(app.getHttpServer())
        .post('/masters/me/subscription/checkout')
        .set('authorization', `Bearer ${master.accessToken}`)
        .send({ billingPeriod: 'monthly', autoRenew: true });
      expect(res.status).toBe(201);
      const { rows } = await pool.query<{ provider_ref: string }>(
        `select provider_ref from subscription_checkouts where master_id = $1 order by created_at desc limit 1`,
        [master.masterId],
      );
      expect((await deliver(stub.pay(rows[0]?.provider_ref ?? ''))).status).toBe(200);

      const cards = await pool.query<{ live: boolean; revoked_reason: string | null }>(
        `select revoked_at is null as live, revoked_reason from subscription_payment_methods
          where master_id = $1 order by created_at`,
        [master.masterId],
      );
      expect(cards.rows).toEqual([
        { live: false, revoked_reason: 'replaced' },
        { live: true, revoked_reason: null },
      ]);
    });
  });

  describe('the renewal job', () => {
    it('charges the saved card once, inside the lead window, and the webhook queues the next period', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 2);

      const [first, again] = await Promise.all([renewals.renewDue(), renewals.renewDue()]);
      const third = await renewals.renewDue();

      expect(first.charged + again.charged + third.charged).toBe(1);
      const charged = await renewalsOf(master.masterId);
      expect(charged).toHaveLength(1);
      const [renewal] = charged;
      expect(renewal?.amount_minor).toBe(String(MONTHLY_MINOR));
      expect(stub.tokenChargedBy(renewal?.provider_ref ?? '')).toMatch(/^tok_/);

      expect((await deliver(stub.pay(renewal?.provider_ref ?? ''))).status).toBe(200);
      expect(await readSubscription(master.accessToken)).toMatchObject({
        status: 'active',
        nextBillingPeriod: 'monthly',
      });
    });

    it('leaves a declined renewal to lapse into grace, and does not charge again', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 2);
      await renewals.renewDue();
      const [renewal] = await renewalsOf(master.masterId);

      expect((await deliver(stub.decline(renewal?.provider_ref ?? ''))).status).toBe(200);
      await renewals.renewDue();

      expect(await renewalsOf(master.masterId)).toHaveLength(1);
      expect(await readSubscription(master.accessToken)).toMatchObject({
        status: 'active',
        nextBillingPeriod: null,
      });
      const kinds = await pool.query<{ kind: string }>(
        `select e.kind from subscription_events e
           join master_subscriptions s on s.id = e.master_subscription_id
          where s.master_id = $1 order by e.created_at, e.id`,
        [master.masterId],
      );
      expect(kinds.rows.map((row) => row.kind)).toEqual(['period_activated', 'payment_failed']);
    });

    it('does not charge a period that ends outside the lead window', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 72);

      await renewals.renewDue();

      expect(await renewalsOf(master.masterId)).toEqual([]);
    });

    it('does not charge a master who declined auto-renewal', async () => {
      const master = await buyMonthly(false);
      await endPeriodIn(master.masterId, 2);

      await renewals.renewDue();

      expect(await renewalsOf(master.masterId)).toEqual([]);
    });

    it('does not charge a cancelled subscription, or a suspended master', async () => {
      const cancelled = await buyMonthly(true);
      await endPeriodIn(cancelled.masterId, 2);
      await subscriptions.cancel(cancelled.masterId, { kind: 'system' });

      const suspended = await buyMonthly(true);
      await endPeriodIn(suspended.masterId, 2);
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [suspended.masterId],
      );

      await renewals.renewDue();

      expect(await renewalsOf(cancelled.masterId)).toEqual([]);
      expect(await renewalsOf(suspended.masterId)).toEqual([]);
    });

    it('does not revive a card saved before a cancellation when the master buys again without it', async () => {
      const master = await buyMonthly(true);
      await subscriptions.cancel(master.masterId, { kind: 'system' });
      // Let the cancelled period lapse, then buy again by hand, declining.
      await pool.query(
        `update master_subscriptions
            set current_period_end = now() - interval '1 minute',
                current_period_start = now() - interval '31 days'
          where master_id = $1`,
        [master.masterId],
      );
      const res = await request(app.getHttpServer())
        .post('/masters/me/subscription/checkout')
        .set('authorization', `Bearer ${master.accessToken}`)
        .send({ billingPeriod: 'monthly' });
      expect(res.status).toBe(201);
      const { rows } = await pool.query<{ provider_ref: string }>(
        `select provider_ref from subscription_checkouts where master_id = $1 order by created_at desc limit 1`,
        [master.masterId],
      );
      expect((await deliver(stub.pay(rows[0]?.provider_ref ?? ''))).status).toBe(200);
      expect(await readSubscription(master.accessToken)).toMatchObject({ status: 'active' });
      await endPeriodIn(master.masterId, 2);

      await renewals.renewDue();

      expect(await renewalsOf(master.masterId)).toEqual([]);
    });

    it('waits while purchases are closed, and charges once they reopen', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 2);
      await pool.query('update subscription_settings set purchases_open = false where id = 1');

      const closed = await renewals.renewDue();
      expect(closed.deferred).toBeGreaterThanOrEqual(1);
      expect(await renewalsOf(master.masterId)).toEqual([]);

      await pool.query('update subscription_settings set purchases_open = true where id = 1');
      await renewals.renewDue();
      expect(await renewalsOf(master.masterId)).toHaveLength(1);
    });

    it('charges a changed price only after its notice, and then at the new price', async () => {
      const master = await buyMonthly(true);
      await endPeriodIn(master.masterId, 2);
      const newer = await insertPrice(MONTHLY_MINOR * 2);
      try {
        const unnoticed = await renewals.renewDue();
        expect(unnoticed.awaitingNotice).toBeGreaterThanOrEqual(1);
        expect(await renewalsOf(master.masterId)).toEqual([]);

        await pool.query(
          `insert into subscription_notices (id, master_subscription_id, kind, dedup_key)
           select gen_random_uuid(), id, 'price_change', $2 from master_subscriptions where master_id = $1`,
          [master.masterId, newer],
        );
        await renewals.renewDue();

        expect(await renewalsOf(master.masterId)).toEqual([
          expect.objectContaining({ price_id: newer, amount_minor: String(MONTHLY_MINOR * 2) }),
        ]);
      } finally {
        await withdraw(newer);
      }
    });
  });

  it('keeps the card token sealed at rest, and still charges with it (#424)', async () => {
    const master = await buyMonthly(true);
    const { rows } = await pool.query<{ token_ref: string }>(
      'select token_ref from subscription_payment_methods where master_id = $1',
      [master.masterId],
    );
    const stored = rows[0]?.token_ref ?? '';

    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('tok_');

    await endPeriodIn(master.masterId, 2);
    await renewals.renewDue();
    const [renewal] = await renewalsOf(master.masterId);
    expect(stub.tokenChargedBy(renewal?.provider_ref ?? '')).toMatch(/^tok_stub_/);
  });

  it('allows a saved card only to be revoked, never edited or deleted', async () => {
    const master = await buyMonthly(true);

    await expect(
      pool.query(`update subscription_payment_methods set token_ref = 'x' where master_id = $1`, [
        master.masterId,
      ]),
    ).rejects.toThrow(/only ever revoked/);
    await expect(
      pool.query('delete from subscription_payment_methods where master_id = $1', [
        master.masterId,
      ]),
    ).rejects.toThrow(/only ever revoked/);
  });
});
