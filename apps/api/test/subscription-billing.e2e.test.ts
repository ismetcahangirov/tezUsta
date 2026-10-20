import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterSubscription, SubscriptionCheckout } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { BILLING_PROVIDER } from '../src/infra/billing/billing.types';
import type { StubBillingProvider, StubDelivery } from '../src/infra/billing/stub-billing.provider';
import { STUB_SIGNATURE_HEADER } from '../src/infra/billing/stub-billing.provider';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { BillingReconciler } from '../src/modules/billing/billing-reconciler.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { addBillingPeriod } from '../src/modules/subscriptions/subscription-period';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Subscription billing over real HTTP, through the real `AppModule` (issue
 * #323): the checkout a master opens, the stub provider's signed webhook that
 * alone extends the period, and reconciliation catching what the webhook
 * missed.
 *
 * The test plays the provider's side through the stub's own helpers — `pay`
 * marks a checkout paid and returns the webhook it would send — so every
 * delivery here is signed with the running app's per-instance key, exactly as
 * a real provider's would be with its secret.
 */

const MONTHLY_MINOR = 2_500;
const YEARLY_MINOR = 25_000;

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

interface SignedInMaster {
  readonly accessToken: string;
  readonly masterId: string;
}

describe('subscription billing over HTTP (issue #323)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessions: SessionsService;
  let stub: StubBillingProvider;
  let reconciler: BillingReconciler;
  let adminId: string;
  let monthlyPriceId: string;

  async function signIn(): Promise<string> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessions.startSession({ userId: created.user.id });
    return pair.accessToken;
  }

  async function signInAsMaster(verification = 'active'): Promise<SignedInMaster> {
    const accessToken = await signIn();
    const res = await request(app.getHttpServer())
      .post('/masters')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ displayName: 'Usta Rauf' });
    expect(res.status).toBe(201);
    const masterId = (res.body as { id: string }).id;
    await pool.query('update masters set verification_status = $2 where id = $1', [
      masterId,
      verification,
    ]);
    return { accessToken, masterId };
  }

  function checkout(accessToken: string | undefined, body: unknown) {
    const pending = request(app.getHttpServer()).post('/masters/me/subscription/checkout');
    return (
      accessToken === undefined ? pending : pending.set('authorization', `Bearer ${accessToken}`)
    ).send(body as object);
  }

  function deliver(delivery: StubDelivery, provider = 'stub') {
    return request(app.getHttpServer())
      .post(`/webhooks/billing/${provider}`)
      .set(delivery.headers)
      .send(delivery.body.toString('utf8'));
  }

  async function readSubscription(accessToken: string): Promise<MasterSubscription> {
    const res = await request(app.getHttpServer())
      .get('/masters/me/subscription')
      .set('authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    return res.body as MasterSubscription;
  }

  async function latestCheckout(masterId: string): Promise<{
    id: string;
    provider_ref: string;
    price_id: string;
    amount_minor: string;
  }> {
    const result = await pool.query<{
      id: string;
      provider_ref: string;
      price_id: string;
      amount_minor: string;
    }>(
      `select id, provider_ref, price_id, amount_minor from subscription_checkouts
        where master_id = $1 order by created_at desc limit 1`,
      [masterId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('No checkout was recorded.');
    }
    return row;
  }

  async function count(sql: string, values: unknown[]): Promise<number> {
    const result = await pool.query<{ n: string }>(sql, values);
    return Number(result.rows[0]?.n ?? 0);
  }

  async function events(masterId: string): Promise<{ kind: string; price_id: string | null }[]> {
    const result = await pool.query<{ kind: string; price_id: string | null }>(
      `select e.kind, e.price_id from subscription_events e
         join master_subscriptions s on s.id = e.master_subscription_id
        where s.master_id = $1 order by e.created_at, e.id`,
      [masterId],
    );
    return result.rows;
  }

  async function insertPrice(period: 'monthly' | 'yearly', minor: number): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into subscription_prices (id, billing_period, price_minor, effective_from, created_by_admin_id)
       values ($1, $2, $3, now() - interval '1 second', $4)`,
      [id, period, minor, adminId],
    );
    return id;
  }

  async function setPurchasesOpen(open: boolean): Promise<void> {
    await pool.query('update subscription_settings set purchases_open = $1 where id = 1', [open]);
  }

  /** A master who has paid for nothing yet opens a checkout and the stub sends its success. */
  async function payFor(
    master: SignedInMaster,
    billingPeriod: 'monthly' | 'yearly',
  ): Promise<{ readonly delivery: StubDelivery; readonly providerRef: string }> {
    const res = await checkout(master.accessToken, { billingPeriod });
    expect(res.status).toBe(201);
    const { provider_ref: providerRef } = await latestCheckout(master.masterId);
    return { delivery: stub.pay(providerRef), providerRef };
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
    reconciler = app.get(BillingReconciler);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    adminId = randomUUID();
    await pool.query(
      `insert into admin_users (id, email, display_name) values ($1, 'billing@tezusta.az', 'Admin')`,
      [adminId],
    );
    monthlyPriceId = await insertPrice('monthly', MONTHLY_MINOR);
    await insertPrice('yearly', YEARLY_MINOR);
  }, 60_000);

  beforeEach(async () => {
    await setPurchasesOpen(true);
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

  describe('POST /masters/me/subscription/checkout', () => {
    it('requires authentication', async () => {
      const res = await checkout(undefined, { billingPeriod: 'monthly' });

      expect(res.status).toBe(401);
    });

    it('is for masters only', async () => {
      const res = await checkout(await signIn(), { billingPeriod: 'monthly' });

      expect(res.status).toBe(403);
    });

    it('refuses a body that names its own price or amount, or no period', async () => {
      const master = await signInAsMaster();

      for (const body of [
        {},
        { billingPeriod: 'weekly' },
        { billingPeriod: 'monthly', amountMinor: 1 },
        { billingPeriod: 'monthly', priceId: randomUUID() },
      ]) {
        const res = await checkout(master.accessToken, body);
        expect(res.status).toBe(422);
      }
      expect(
        await count('select count(*) as n from subscription_checkouts where master_id = $1', [
          master.masterId,
        ]),
      ).toBe(0);
    });

    it('refuses a master verification has not approved, and opens nothing', async () => {
      const master = await signInAsMaster('pending_verification');
      const createCheckout = vi.spyOn(stub, 'createCheckout');

      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });

      expect(res.status).toBe(409);
      expect(createCheckout).not.toHaveBeenCalled();
      createCheckout.mockRestore();
    });

    it('refuses while purchases are closed, and opens nothing at the provider', async () => {
      await setPurchasesOpen(false);
      const master = await signInAsMaster();
      const createCheckout = vi.spyOn(stub, 'createCheckout');

      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('SUBSCRIPTION_PURCHASES_CLOSED');
      expect(createCheckout).not.toHaveBeenCalled();
      expect(
        await count('select count(*) as n from subscription_checkouts where master_id = $1', [
          master.masterId,
        ]),
      ).toBe(0);
      createCheckout.mockRestore();
    });

    it('opens a hosted checkout at the server price, and hands it back when asked again', async () => {
      const master = await signInAsMaster();

      const first = await checkout(master.accessToken, { billingPeriod: 'monthly' });
      const again = await checkout(master.accessToken, { billingPeriod: 'monthly' });

      expect(first.status).toBe(201);
      const body = first.body as SubscriptionCheckout;
      expect(body).toMatchObject({
        billingPeriod: 'monthly',
        amountMinor: MONTHLY_MINOR,
        currency: 'AZN',
      });
      expect(body.checkoutUrl).toMatch(/^https:\/\//);
      expect((again.body as SubscriptionCheckout).checkoutUrl).toBe(body.checkoutUrl);
      expect(
        await count('select count(*) as n from subscription_checkouts where master_id = $1', [
          master.masterId,
        ]),
      ).toBe(1);
    });

    it('opens a new checkout once the previous one has been paid', async () => {
      const master = await signInAsMaster();
      const { delivery } = await payFor(master, 'monthly');
      expect((await deliver(delivery)).status).toBe(200);

      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });

      expect(res.status).toBe(201);
      expect(
        await count('select count(*) as n from subscription_checkouts where master_id = $1', [
          master.masterId,
        ]),
      ).toBe(2);
    });

    it('refuses a third period while a bought one is already queued', async () => {
      const master = await signInAsMaster();
      expect((await deliver((await payFor(master, 'monthly')).delivery)).status).toBe(200);
      expect((await deliver((await payFor(master, 'monthly')).delivery)).status).toBe(200);

      const res = await checkout(master.accessToken, { billingPeriod: 'yearly' });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('SUBSCRIPTION_PERIOD_ALREADY_QUEUED');
    });
  });

  describe('POST /webhooks/billing/:provider', () => {
    it('a paid monthly checkout makes the subscription active for one calendar month', async () => {
      const master = await signInAsMaster();
      const { delivery } = await payFor(master, 'monthly');

      const res = await deliver(delivery);

      expect(res.status).toBe(200);
      const subscription = await readSubscription(master.accessToken);
      expect(subscription).toMatchObject({
        status: 'active',
        billingPeriod: 'monthly',
        entitled: true,
      });
      expect(subscription.currentPeriodEnd).toBe(
        addBillingPeriod(new Date(subscription.currentPeriodStart), 'monthly').toISOString(),
      );
    });

    it('a paid yearly checkout makes it active for one calendar year', async () => {
      const master = await signInAsMaster();
      const { delivery } = await payFor(master, 'yearly');

      expect((await deliver(delivery)).status).toBe(200);

      const subscription = await readSubscription(master.accessToken);
      expect(subscription).toMatchObject({ status: 'active', billingPeriod: 'yearly' });
      expect(subscription.currentPeriodEnd).toBe(
        addBillingPeriod(new Date(subscription.currentPeriodStart), 'yearly').toISOString(),
      );
    });

    it('a replayed delivery does not extend the period twice', async () => {
      const master = await signInAsMaster();
      const { delivery } = await payFor(master, 'monthly');

      expect((await deliver(delivery)).status).toBe(200);
      const once = await readSubscription(master.accessToken);
      const replays = await Promise.all([deliver(delivery), deliver(delivery)]);

      expect(replays.map((res) => res.status)).toEqual([200, 200]);
      expect(await readSubscription(master.accessToken)).toEqual(once);
      expect((await events(master.masterId)).map((event) => event.kind)).toEqual([
        'period_activated',
      ]);
    });

    it('a second success event for the same payment buys nothing more', async () => {
      const master = await signInAsMaster();
      const { delivery, providerRef } = await payFor(master, 'monthly');
      expect((await deliver(delivery)).status).toBe(200);
      const once = await readSubscription(master.accessToken);

      const second = stub.deliver('payment.succeeded', {
        ref: providerRef,
        amountMinor: MONTHLY_MINOR,
        currency: 'AZN',
      });
      expect((await deliver(second)).status).toBe(200);

      expect(await readSubscription(master.accessToken)).toEqual(once);
      const dispositions = await pool.query<{ disposition: string }>(
        `select disposition from subscription_payments where provider_ref = $1 order by created_at`,
        [providerRef],
      );
      expect(dispositions.rows.map((row) => row.disposition)).toEqual([
        'activated',
        'already_applied',
      ]);
    });

    it('refuses a bad signature, a missing one and a tampered body, and changes nothing', async () => {
      const master = await signInAsMaster();
      const { delivery, providerRef } = await payFor(master, 'monthly');
      const tampered: StubDelivery = {
        headers: delivery.headers,
        body: Buffer.from(delivery.body.toString('utf8').replace(/"id":"[^"]+"/, '"id":"evt_x"')),
      };

      const results = await Promise.all([
        deliver({ ...delivery, headers: { ...delivery.headers, [STUB_SIGNATURE_HEADER]: 'x' } }),
        deliver({ ...delivery, headers: { 'content-type': 'application/json' } }),
        deliver(tampered),
      ]);

      expect(results.map((res) => res.status)).toEqual([401, 401, 401]);
      expect(
        await count('select count(*) as n from subscription_payments where provider_ref = $1', [
          providerRef,
        ]),
      ).toBe(0);
      await expect(readSubscription(master.accessToken)).rejects.toThrow();
    });

    it('answers 404 for a provider that is not the configured one', async () => {
      const master = await signInAsMaster();
      const { delivery } = await payFor(master, 'monthly');

      const res = await deliver(delivery, 'payriff');

      expect(res.status).toBe(404);
    });

    it('refuses a body over 64 KiB before reading it', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/billing/stub')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));

      expect(res.status).toBe(413);
    });

    it('activates against the price recorded at checkout, not a price changed since', async () => {
      const master = await signInAsMaster();
      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });
      expect(res.status).toBe(201);
      const opened = await latestCheckout(master.masterId);

      // An admin price change lands between the checkout and the payment.
      const newer = await insertPrice('monthly', MONTHLY_MINOR * 2);
      try {
        expect((await deliver(stub.pay(opened.provider_ref))).status).toBe(200);

        const paid = await pool.query<{ price_id: string; amount_minor: string }>(
          `select e.price_id, e.amount_minor from subscription_events e
             join master_subscriptions s on s.id = e.master_subscription_id
            where s.master_id = $1 and e.kind = 'period_activated'`,
          [master.masterId],
        );
        expect(paid.rows).toEqual([
          { price_id: monthlyPriceId, amount_minor: String(MONTHLY_MINOR) },
        ]);
      } finally {
        // Withdrawn, so the suites after this one see the original price.
        await pool.query(
          `insert into subscription_prices (id, billing_period, price_minor, effective_from,
                                            created_by_admin_id, withdraws_price_id)
           values ($1, 'monthly', null, now(), $2, $3)`,
          [randomUUID(), adminId, newer],
        );
      }
    });

    it('activates nothing when the provider says a different amount was paid', async () => {
      const master = await signInAsMaster();
      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });
      expect(res.status).toBe(201);
      const opened = await latestCheckout(master.masterId);

      const delivery = stub.pay(opened.provider_ref, { amountMinor: 1 });
      expect((await deliver(delivery)).status).toBe(200);

      await expect(readSubscription(master.accessToken)).rejects.toThrow();
      const recorded = await pool.query<{ disposition: string }>(
        'select disposition from subscription_payments where checkout_id = $1',
        [opened.id],
      );
      expect(recorded.rows).toEqual([{ disposition: 'amount_mismatch' }]);
    });

    it('records a late failure and a refund as events, and leaves the period as it was', async () => {
      const master = await signInAsMaster();
      const { delivery, providerRef } = await payFor(master, 'monthly');
      expect((await deliver(delivery)).status).toBe(200);
      const paid = await readSubscription(master.accessToken);

      // Out of order: a failed attempt from before the success arrives after it.
      const lateFailure = stub.deliver('payment.failed', {
        ref: providerRef,
        occurredAt: new Date(Date.now() - 60_000),
      });
      const refund = stub.deliver('payment.refunded', {
        ref: providerRef,
        amountMinor: MONTHLY_MINOR,
        currency: 'AZN',
      });
      expect((await deliver(lateFailure)).status).toBe(200);
      expect((await deliver(refund)).status).toBe(200);
      expect((await deliver(refund)).status).toBe(200);

      expect(await readSubscription(master.accessToken)).toEqual(paid);
      expect((await events(master.masterId)).map((event) => event.kind)).toEqual([
        'period_activated',
        'payment_failed',
        'payment_refunded',
      ]);
    });

    it('a success that arrives after a failure on the same checkout still buys the period', async () => {
      const master = await signInAsMaster();
      const res = await checkout(master.accessToken, { billingPeriod: 'monthly' });
      expect(res.status).toBe(201);
      const opened = await latestCheckout(master.masterId);

      expect(
        (await deliver(stub.deliver('payment.failed', { ref: opened.provider_ref }))).status,
      ).toBe(200);
      expect((await deliver(stub.pay(opened.provider_ref))).status).toBe(200);

      expect(await readSubscription(master.accessToken)).toMatchObject({ status: 'active' });
    });

    it('records an event for a checkout it never opened, and changes nothing', async () => {
      const ref = `stub_${randomUUID()}`;
      const delivery = stub.deliver('payment.succeeded', {
        ref,
        amountMinor: MONTHLY_MINOR,
        currency: 'AZN',
      });

      expect((await deliver(delivery)).status).toBe(200);

      const recorded = await pool.query<{ disposition: string; checkout_id: string | null }>(
        'select disposition, checkout_id from subscription_payments where provider_ref = $1',
        [ref],
      );
      expect(recorded.rows).toEqual([{ disposition: 'unknown_checkout', checkout_id: null }]);
    });

    it('answers 200 to a genuine event it does not act on, and records nothing', async () => {
      const ref = `stub_${randomUUID()}`;

      expect((await deliver(stub.deliver('customer.updated', { ref }))).status).toBe(200);

      expect(
        await count('select count(*) as n from subscription_payments where provider_ref = $1', [
          ref,
        ]),
      ).toBe(0);
    });
  });

  describe('reconciliation', () => {
    it('finds a payment whose webhook never arrived, and a provider amount that disagrees', async () => {
      const before = await reconciler.reconcile();

      // Paid at the provider; the webhook is never delivered.
      const unannounced = await signInAsMaster();
      await payFor(unannounced, 'monthly');

      // Delivered and activated; then the provider's records change.
      const drifted = await signInAsMaster();
      const { delivery, providerRef } = await payFor(drifted, 'monthly');
      expect((await deliver(delivery)).status).toBe(200);
      stub.setLookup(providerRef, { status: 'paid', amountMinor: 1, currency: 'AZN' });

      const after = await reconciler.reconcile();

      expect(after.checked - before.checked).toBe(2);
      expect(after.unrecordedPayments - before.unrecordedPayments).toBe(1);
      expect(after.amountMismatches - before.amountMismatches).toBe(1);
      expect(after.unconfirmedPayments).toBe(before.unconfirmedPayments);
      expect(after.unrecordedRefunds).toBe(before.unrecordedRefunds);
      // It corrects nothing: the webhook alone activates a period.
      await expect(readSubscription(unannounced.accessToken)).rejects.toThrow();
    });
  });

  it('keeps checkouts and payments append-only', async () => {
    await expect(pool.query('update subscription_checkouts set amount_minor = 1')).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('delete from subscription_payments')).rejects.toThrow(/append-only/);
  });
});
