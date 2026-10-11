import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { Clock } from '../src/common/time/clock';
import { CLOCK } from '../src/common/time/clock';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { PushEnvelope } from '../src/infra/push/push-sender.types';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { DevicesService } from '../src/modules/devices/devices.service';
import { SubscriptionOfferService } from '../src/modules/subscriptions/subscription-offer.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

function baku(local: string): Date {
  return new Date(`${local}+04:00`);
}

class PinnedClock implements Clock {
  private current = baku('2027-03-10T12:00:00');
  now(): Date {
    return this.current;
  }
  set(instant: Date): void {
    this.current = instant;
  }
}

async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Long enough for the notification worker to drain anything a wrong second send would queue. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

interface Master {
  readonly masterId: string;
  readonly pushToken: string;
}

/**
 * Subscription pushes (issue #326, ADR-0046 § 5–7), end to end: the real
 * transitions and sweep, the real `notifications` queue and worker, and the
 * stub push sender recording what would have left. The clock the
 * subscription module reads is pinned, so a lapse is walked through instant by
 * instant without sleeping.
 */
describe('subscription pushes (issue #326)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let push: StubPushSender;
  let subscriptions: SubscriptionsService;
  let adminId: string;
  let monthlyPriceId: string;
  let yearlyPriceId: string;
  const clock = new PinnedClock();
  let counter = 0;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  function pushesTo(master: Master, kind?: string): PushEnvelope[] {
    return push.sent.filter(
      (envelope) =>
        envelope.pushToken === master.pushToken &&
        (kind === undefined || envelope.data.kind === kind),
    );
  }

  function kindsTo(master: Master): string[] {
    return pushesTo(master).map((envelope) => envelope.data.kind);
  }

  async function seedMaster(): Promise<Master> {
    counter += 1;
    const created = await app.get(UsersRepository).create({
      phoneE164: `+99470${String(counter).padStart(7, '0')}`,
      roles: [],
    });
    const pushToken = `ExponentPushToken[sub-${randomUUID()}]`;
    await app
      .get(DevicesService)
      .register(
        { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
        { expoPushToken: pushToken, platform: 'android' },
      );
    const { rows } = await pool.query<{ id: string }>(
      `insert into masters (id, user_id, display_name, verification_status)
       values (gen_random_uuid(), $1, 'Rəşad', 'active') returning id`,
      [created.user.id],
    );
    const masterId = rows[0]?.id;
    if (masterId === undefined) throw new Error('no master');
    return { masterId, pushToken };
  }

  async function pay(
    master: Master,
    billingPeriod: 'monthly' | 'yearly',
    ref: string = randomUUID(),
  ) {
    await subscriptions.activatePeriod({
      masterId: master.masterId,
      billingPeriod,
      priceId: billingPeriod === 'monthly' ? monthlyPriceId : yearlyPriceId,
      paymentRef: ref,
    });
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    await runSeed(database.url);
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    push = app.get<StubPushSender>(PUSH_SENDER);
    subscriptions = app.get(SubscriptionsService);
    pool = new Pool({ connectionString: database.url });

    adminId = randomUUID();
    await pool.query(
      `insert into admin_users (id, email, display_name) values ($1, 'finance@tezusta.az', 'Admin')`,
      [adminId],
    );
    const prices = await pool.query<{ id: string; billing_period: string }>(
      `insert into subscription_prices (id, billing_period, price_minor, effective_from, created_by_admin_id)
       values (gen_random_uuid(), 'monthly', 2000, '2027-01-01T00:00:00Z', $1),
              (gen_random_uuid(), 'yearly', 20000, '2027-01-01T00:00:00Z', $1)
       returning id, billing_period`,
      [adminId],
    );
    monthlyPriceId = prices.rows.find((row) => row.billing_period === 'monthly')?.id ?? '';
    yearlyPriceId = prices.rows.find((row) => row.billing_period === 'yearly')?.id ?? '';
  }, 120_000);

  beforeEach(() => {
    clock.set(baku('2027-03-10T12:00:00'));
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

  it('sends exactly one renewed, one ending, one grace and one expired push across a lapse', async () => {
    const master = await seedMaster();
    const end = baku('2027-04-10T12:00:00');
    const graceEnd = baku('2027-04-13T12:00:00');

    await pay(master, 'monthly');
    await eventually(() => pushesTo(master, 'subscription-renewed').length === 1);

    // Four days out: too early for the warning.
    await subscriptions.noticeEndingSoon(baku('2027-04-06T11:00:00'), 100);
    // Inside the three days, twice: one warning.
    await subscriptions.noticeEndingSoon(baku('2027-04-07T13:00:00'), 100);
    await subscriptions.noticeEndingSoon(baku('2027-04-08T09:00:00'), 100);
    await eventually(() => pushesTo(master, 'subscription-ending').length === 1);

    // The period ends unpaid; the sweep runs twice.
    await subscriptions.enterGrace(end, 100);
    await subscriptions.enterGrace(new Date(end.getTime() + 60_000), 100);
    await eventually(() => pushesTo(master, 'subscription-grace').length === 1);

    // Grace runs out; the sweep runs twice.
    await subscriptions.expireDue(graceEnd, 100);
    await subscriptions.expireDue(new Date(graceEnd.getTime() + 60_000), 100);
    await eventually(() => pushesTo(master, 'subscription-expired').length === 1);
    // And the warning is not repeated for a period already over.
    await subscriptions.noticeEndingSoon(graceEnd, 100);

    await settle();
    expect(kindsTo(master)).toEqual([
      'subscription-renewed',
      'subscription-ending',
      'subscription-grace',
      'subscription-expired',
    ]);
  });

  it('carries the kind and nothing else, on the subscription channel, with dates and no price', async () => {
    const master = await seedMaster();
    await pay(master, 'yearly');
    await eventually(() => pushesTo(master, 'subscription-renewed').length === 1);

    const [renewed] = pushesTo(master, 'subscription-renewed');
    expect(renewed?.data).toEqual({
      kind: 'subscription-renewed',
      orderId: undefined,
      orderStatus: undefined,
    });
    expect(renewed?.channelId).toBe('subscription');
    expect(renewed?.title).toBe('Abunəniz yeniləndi');
    expect(renewed?.body).toBe('İllik abunəniz 10 mart tarixinədək aktivdir.');
    expect(renewed?.body).not.toMatch(/₼|AZN|200/);
  });

  it('renews once when the same payment is confirmed twice', async () => {
    const master = await seedMaster();
    const ref = `pay-${randomUUID()}`;
    await pay(master, 'monthly', ref);
    await pay(master, 'monthly', ref);
    await settle();
    expect(pushesTo(master, 'subscription-renewed')).toHaveLength(1);
  });

  it('does not warn of an end when a paid period is queued after it', async () => {
    const master = await seedMaster();
    await pay(master, 'monthly');
    clock.set(baku('2027-03-25T12:00:00'));
    await pay(master, 'yearly');

    await subscriptions.noticeEndingSoon(baku('2027-04-08T12:00:00'), 100);
    await settle();
    expect(pushesTo(master, 'subscription-ending')).toHaveLength(0);
    // Two payments, two renewals: the month, and the year queued behind it.
    expect(pushesTo(master, 'subscription-renewed')).toHaveLength(2);
  });

  it('tells masters renewing on a period that its price is changing and from when, once', async () => {
    const monthly = await seedMaster();
    const yearly = await seedMaster();
    // On monthly now, but a year is queued: their next renewal is yearly.
    const switching = await seedMaster();
    await pay(monthly, 'monthly');
    await pay(yearly, 'yearly');
    await pay(switching, 'monthly');
    await pay(switching, 'yearly');
    const effectiveFrom = baku('2027-04-15T00:00:00');

    await app
      .get(SubscriptionOfferService)
      .changePrices({ monthlyMinor: 2_500, effectiveFrom, adminUserId: adminId }, () =>
        Promise.resolve(),
      );
    // The sweep tells them, and a second run tells nobody again.
    const now = clock.now();
    await subscriptions.noticeScheduledPrices(now, 100);
    await subscriptions.noticeScheduledPrices(now, 100);
    await eventually(() => pushesTo(monthly, 'subscription-price-change').length === 1);

    const [notice] = pushesTo(monthly, 'subscription-price-change');
    expect(notice?.body).toBe('Aylıq abunənin qiyməti 15 aprel tarixindən dəyişir.');
    expect(notice?.body).not.toMatch(/25|₼|AZN/);

    // A master who starts paying monthly after the change was scheduled is told on the next run.
    const late = await seedMaster();
    await pay(late, 'monthly');
    await subscriptions.noticeScheduledPrices(now, 100);
    await eventually(() => pushesTo(late, 'subscription-price-change').length === 1);

    await settle();
    expect(pushesTo(monthly, 'subscription-price-change')).toHaveLength(1);
    expect(pushesTo(yearly, 'subscription-price-change')).toHaveLength(0);
    expect(pushesTo(switching, 'subscription-price-change')).toHaveLength(0);
  });

  it('says only "renewed" when a payment lands after the period ended and before the sweep', async () => {
    const master = await seedMaster();
    await pay(master, 'monthly');
    // The period ended 30 seconds ago; the sweep has not run yet.
    clock.set(new Date(baku('2027-04-10T12:00:00').getTime() + 30_000));
    await pay(master, 'monthly');

    await settle();
    expect(kindsTo(master)).toEqual(['subscription-renewed', 'subscription-renewed']);
  });

  it('still says a lapse happened when nothing replaces it — a cancellation after the end', async () => {
    const master = await seedMaster();
    await pay(master, 'monthly');
    clock.set(new Date(baku('2027-04-10T12:00:00').getTime() + 30_000));
    // An admin cancels in grace the sweep has not entered yet: grace is still news.
    await subscriptions.cancel(master.masterId, { kind: 'system' });

    await eventually(() => pushesTo(master, 'subscription-grace').length === 1);
  });
});
