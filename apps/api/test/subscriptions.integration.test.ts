import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/common/errors/app-error';
import type { Clock } from '../src/common/time/clock';
import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import { subscriptionEntitlement } from '../src/modules/subscriptions/subscription-entitlement';
import { SubscriptionsRepository } from '../src/modules/subscriptions/subscriptions.repository';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The master subscription against a real database (issue #322): the
 * append-only and single-row rules the migration installs, every transition
 * writing exactly one event, idempotent activation under concurrency, the
 * sweep, and the entitlement exactly at its boundaries.
 *
 * The service is built by hand over a pinned {@link Clock} rather than booted
 * through `AppModule`: every test here is about what happens at a particular
 * instant, and moving a clock is how that is tested without sleeping. The
 * HTTP surface and the dispatch gate are covered in their own suites.
 */

function baku(local: string): Date {
  return new Date(`${local}+04:00`);
}

class PinnedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(instant: Date): void {
    this.current = instant;
  }
}

interface EventRow {
  kind: string;
  from_status: string | null;
  to_status: string;
  period_start: Date;
  period_end: Date;
  billing_period: string | null;
  price_id: string | null;
  amount_minor: string | null;
  payment_ref: string | null;
  actor: string;
  reason: string | null;
}

describe('the master subscription (issue #322)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let db: Database;
  let clock: PinnedClock;
  let subscriptions: SubscriptionsService;
  let adminId: string;
  let monthlyPriceId: string;
  let yearlyPriceId: string;
  /** The settings row exactly as the migration left it, before any test touched it. */
  let seededSettings: unknown;

  async function seedMaster(): Promise<string> {
    const userId = randomUUID();
    const masterId = randomUUID();
    await pool.query('insert into users (id, phone_e164) values ($1, $2)', [
      userId,
      `+99450${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
    ]);
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status)
       values ($1, $2, 'Usta Test', 'active')`,
      [masterId, userId],
    );
    return masterId;
  }

  async function seedPrice(
    billingPeriod: 'monthly' | 'yearly',
    priceMinor: number,
    effectiveFrom: Date,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into subscription_prices (id, billing_period, price_minor, effective_from, created_by_admin_id)
       values ($1, $2, $3, $4, $5)`,
      [id, billingPeriod, priceMinor, effectiveFrom, adminId],
    );
    return id;
  }

  async function eventsOf(masterId: string): Promise<EventRow[]> {
    const result = await pool.query<EventRow>(
      `select e.kind, e.from_status, e.to_status, e.period_start, e.period_end, e.billing_period,
              e.price_id, e.amount_minor, e.payment_ref, e.actor, e.reason
         from subscription_events e
         join master_subscriptions s on s.id = e.master_subscription_id
        where s.master_id = $1
        order by e.created_at, e.id`,
      [masterId],
    );
    return result.rows;
  }

  async function errorCodeOf(work: Promise<unknown>): Promise<string | undefined> {
    try {
      await work;
    } catch (error) {
      if (error instanceof AppError) {
        return error.code;
      }
      throw error;
    }
    return undefined;
  }

  /** A master on a paid monthly period from `start`. */
  async function activeMaster(start: Date, ref: string = randomUUID()): Promise<string> {
    const masterId = await seedMaster();
    clock.set(start);
    await subscriptions.activatePeriod({
      masterId,
      billingPeriod: 'monthly',
      priceId: monthlyPriceId,
      paymentRef: ref,
    });
    return masterId;
  }

  async function statusOf(masterId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from master_subscriptions where master_id = $1',
      [masterId],
    );
    return rows[0]?.status;
  }

  async function entitledAt(masterId: string, at: Date): Promise<boolean> {
    const result = await db.execute<{ entitled: boolean }>(
      sql`select ${subscriptionEntitlement(sql`${masterId}::uuid`, sql`${at.toISOString()}::timestamptz`)} as entitled`,
    );
    return result.rows[0]?.entitled === true;
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    pool = new Pool({ connectionString: database.url, max: 8 });
    seededSettings = (
      await pool.query(
        'select id, trial_days, grace_days, purchases_open, updated_by_admin_id from subscription_settings',
      )
    ).rows;
    db = drizzle(pool, { schema });
    clock = new PinnedClock(baku('2027-03-10T12:00:00'));
    subscriptions = new SubscriptionsService(new SubscriptionsRepository(db), clock);

    adminId = randomUUID();
    await pool.query(
      `insert into admin_users (id, email, display_name) values ($1, 'pricing@tezusta.az', 'Admin')`,
      [adminId],
    );
    monthlyPriceId = await seedPrice('monthly', 2_000, baku('2027-01-01T00:00:00'));
    yearlyPriceId = await seedPrice('yearly', 20_000, baku('2027-01-01T00:00:00'));
  });

  beforeEach(async () => {
    await pool.query(
      `update subscription_settings set trial_days = 14, grace_days = 3, purchases_open = false`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('the tables the migration installs', () => {
    it('seeds one settings row: a 14-day trial, 3 days of grace, purchases closed', () => {
      expect(seededSettings).toEqual([
        { id: 1, trial_days: 14, grace_days: 3, purchases_open: false, updated_by_admin_id: null },
      ]);
    });

    it('refuses a second settings row, its deletion, and values outside the bounds', async () => {
      await expect(
        pool.query(
          `insert into subscription_settings (id, trial_days, grace_days) values (2, 1, 1)`,
        ),
      ).rejects.toThrow(/subscription_settings_single_row/);
      await expect(pool.query('delete from subscription_settings')).rejects.toThrow(
        /cannot be removed/,
      );
      await expect(pool.query('update subscription_settings set trial_days = 91')).rejects.toThrow(
        /trial_days_range/,
      );
      await expect(pool.query('update subscription_settings set grace_days = 31')).rejects.toThrow(
        /grace_days_range/,
      );
    });

    it('refuses UPDATE, DELETE and TRUNCATE on subscription_prices', async () => {
      await expect(
        pool.query('update subscription_prices set price_minor = 1 where id = $1', [
          monthlyPriceId,
        ]),
      ).rejects.toThrow(/subscription_prices is append-only: UPDATE/);
      await expect(
        pool.query('delete from subscription_prices where id = $1', [monthlyPriceId]),
      ).rejects.toThrow(/subscription_prices is append-only: DELETE/);
      await expect(pool.query('truncate subscription_prices cascade')).rejects.toThrow(
        /append-only: TRUNCATE/,
      );
    });

    it('refuses a price that is not a positive amount in AZN', async () => {
      await expect(seedPrice('monthly', 0, new Date())).rejects.toThrow(/price_positive/);
      await expect(
        pool.query(
          `insert into subscription_prices (id, billing_period, price_minor, currency, effective_from, created_by_admin_id)
           values (gen_random_uuid(), 'monthly', 100, 'USD', now(), $1)`,
          [adminId],
        ),
      ).rejects.toThrow(/currency_azn/);
    });

    it('refuses UPDATE, DELETE and TRUNCATE on subscription_events', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      const { rows } = await pool.query<{ id: string }>(
        `select e.id from subscription_events e
           join master_subscriptions s on s.id = e.master_subscription_id where s.master_id = $1`,
        [masterId],
      );
      const eventId = rows[0]?.id;
      await expect(
        pool.query(`update subscription_events set reason = 'edited' where id = $1`, [eventId]),
      ).rejects.toThrow(/subscription_events is append-only: UPDATE/);
      await expect(
        pool.query('delete from subscription_events where id = $1', [eventId]),
      ).rejects.toThrow(/subscription_events is append-only: DELETE/);
      await expect(pool.query('truncate subscription_events')).rejects.toThrow(
        /append-only: TRUNCATE/,
      );
    });
  });

  describe('the trial', () => {
    it('starts for the configured length, with one event, and only once', async () => {
      const masterId = await seedMaster();
      clock.set(baku('2027-03-10T12:00:00'));

      expect(await subscriptions.startTrial(masterId)).toBe(true);
      expect(await subscriptions.startTrial(masterId)).toBe(false);

      const view = await subscriptions.readOwn(masterId);
      expect(view).toMatchObject({
        status: 'trialing',
        billingPeriod: null,
        currentPeriodEnd: baku('2027-03-24T12:00:00').toISOString(),
        entitled: true,
      });
      const events = await eventsOf(masterId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'trial_started',
        from_status: null,
        to_status: 'trialing',
        actor: 'system',
      });
    });

    it('uses the trial length in the settings at the moment it starts', async () => {
      await pool.query('update subscription_settings set trial_days = 30');
      const masterId = await seedMaster();
      clock.set(baku('2027-03-10T12:00:00'));
      await subscriptions.startTrial(masterId);
      expect((await subscriptions.readOwn(masterId)).currentPeriodEnd).toBe(
        baku('2027-04-09T12:00:00').toISOString(),
      );
    });

    it('expires exactly at its end, with no grace', async () => {
      const masterId = await seedMaster();
      clock.set(baku('2027-03-10T12:00:00'));
      await subscriptions.startTrial(masterId);
      const end = baku('2027-03-24T12:00:00');

      await subscriptions.enterGrace(end, 100);
      expect(await statusOf(masterId)).toBe('trialing');
      await subscriptions.expireDue(new Date(end.getTime() - 1), 100);
      expect(await statusOf(masterId)).toBe('trialing');
      await subscriptions.expireDue(end, 100);
      expect(await statusOf(masterId)).toBe('expired');
      expect((await eventsOf(masterId)).map((e) => e.kind)).toEqual(['trial_started', 'expired']);
    });
  });

  describe('activating a paid period', () => {
    it('records the price paid against and the amount, as the provider', async () => {
      const ref = `pay-${randomUUID()}`;
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'), ref);

      const view = await subscriptions.readOwn(masterId);
      expect(view).toMatchObject({
        status: 'active',
        billingPeriod: 'monthly',
        currentPeriodEnd: baku('2027-04-10T12:00:00').toISOString(),
      });
      expect(await eventsOf(masterId)).toEqual([
        expect.objectContaining({
          kind: 'period_activated',
          price_id: monthlyPriceId,
          amount_minor: '2000',
          payment_ref: ref,
          actor: 'provider',
        }),
      ]);
    });

    it('extends the period once when the same payment is confirmed twice', async () => {
      const ref = `pay-${randomUUID()}`;
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'), ref);
      clock.set(baku('2027-03-11T12:00:00'));
      await subscriptions.activatePeriod({
        masterId,
        billingPeriod: 'monthly',
        priceId: monthlyPriceId,
        paymentRef: ref,
      });

      expect((await subscriptions.readOwn(masterId)).nextBillingPeriod).toBeNull();
      expect(await eventsOf(masterId)).toHaveLength(1);
    });

    it('extends the period once when the same payment is confirmed twice at the same moment', async () => {
      const masterId = await seedMaster();
      clock.set(baku('2027-03-10T12:00:00'));
      const ref = `pay-${randomUUID()}`;
      const input = {
        masterId,
        billingPeriod: 'monthly' as const,
        priceId: monthlyPriceId,
        paymentRef: ref,
      };

      await Promise.all([
        subscriptions.activatePeriod(input),
        subscriptions.activatePeriod(input),
        subscriptions.activatePeriod(input),
      ]);

      const view = await subscriptions.readOwn(masterId);
      expect(view).toMatchObject({
        status: 'active',
        currentPeriodEnd: baku('2027-04-10T12:00:00').toISOString(),
        nextBillingPeriod: null,
      });
      expect(await eventsOf(masterId)).toHaveLength(1);
    });

    it('queues a yearly period bought mid-month behind the month, then starts it at the month end', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      clock.set(baku('2027-03-25T09:00:00'));
      await subscriptions.activatePeriod({
        masterId,
        billingPeriod: 'yearly',
        priceId: yearlyPriceId,
        paymentRef: `pay-${randomUUID()}`,
      });

      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        billingPeriod: 'monthly',
        currentPeriodEnd: baku('2027-04-10T12:00:00').toISOString(),
        nextBillingPeriod: 'yearly',
      });

      const monthEnd = baku('2027-04-10T12:00:00');
      await subscriptions.enterGrace(monthEnd, 100);
      expect(await statusOf(masterId)).toBe('active');
      await subscriptions.startQueuedPeriods(monthEnd, 100);

      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        status: 'active',
        billingPeriod: 'yearly',
        currentPeriodStart: monthEnd.toISOString(),
        currentPeriodEnd: baku('2028-04-10T12:00:00').toISOString(),
        nextBillingPeriod: null,
      });
      expect((await eventsOf(masterId)).map((e) => e.kind)).toEqual([
        'period_activated',
        'period_queued',
        'queued_period_started',
      ]);
    });

    it('refuses a second queued period', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      const buy = () =>
        subscriptions.activatePeriod({
          masterId,
          billingPeriod: 'monthly',
          priceId: monthlyPriceId,
          paymentRef: `pay-${randomUUID()}`,
        });
      await buy();
      expect(await errorCodeOf(buy())).toBe('SUBSCRIPTION_PERIOD_ALREADY_QUEUED');
      expect(await eventsOf(masterId)).toHaveLength(2);
    });

    it('refuses a price of the other billing period, and writes nothing', async () => {
      const masterId = await seedMaster();
      await expect(
        subscriptions.activatePeriod({
          masterId,
          billingPeriod: 'monthly',
          priceId: yearlyPriceId,
          paymentRef: `pay-${randomUUID()}`,
        }),
      ).rejects.toThrow(/not a payable monthly price/);
      expect(await eventsOf(masterId)).toEqual([]);
    });

    it('keeps the price on a period already paid when the price changes, and charges the next one at the new price', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      const raised = await seedPrice('monthly', 2_500, baku('2027-03-15T00:00:00'));

      clock.set(baku('2027-03-14T12:00:00'));
      expect((await subscriptions.offer()).monthly?.priceMinor).toBe(2_000);
      clock.set(baku('2027-03-15T00:00:00'));
      expect((await subscriptions.offer()).monthly).toMatchObject({
        priceMinor: 2_500,
        effectiveFrom: baku('2027-03-15T00:00:00').toISOString(),
      });

      await subscriptions.activatePeriod({
        masterId,
        billingPeriod: 'monthly',
        priceId: raised,
        paymentRef: `pay-${randomUUID()}`,
      });

      const events = await eventsOf(masterId);
      expect(events.map((e) => [e.kind, e.price_id, e.amount_minor])).toEqual([
        ['period_activated', monthlyPriceId, '2000'],
        ['period_queued', raised, '2500'],
      ]);
    });
  });

  describe('grace and expiry', () => {
    it('enters grace exactly at the period end, for the grace days set at that moment', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      const end = baku('2027-04-10T12:00:00');

      await subscriptions.enterGrace(new Date(end.getTime() - 1), 100);
      expect(await statusOf(masterId)).toBe('active');
      await pool.query('update subscription_settings set grace_days = 5');
      await subscriptions.enterGrace(end, 100);

      clock.set(end);
      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        status: 'past_due',
        graceEndsAt: baku('2027-04-15T12:00:00').toISOString(),
        entitled: true,
      });
    });

    it('expires exactly at the grace end, not before', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.enterGrace(baku('2027-04-10T12:00:00'), 100);
      const graceEnd = baku('2027-04-13T12:00:00');

      await subscriptions.expireDue(new Date(graceEnd.getTime() - 1), 100);
      expect(await statusOf(masterId)).toBe('past_due');
      await subscriptions.expireDue(graceEnd, 100);
      expect(await statusOf(masterId)).toBe('expired');
      expect((await eventsOf(masterId)).map((e) => e.kind)).toEqual([
        'period_activated',
        'grace_entered',
        'expired',
      ]);
    });

    it('sweeps a row whose timestamps carry microseconds, as the migration backfill writes them', async () => {
      // `now()` has microsecond precision and a JavaScript Date has
      // millisecond precision, so a row written by SQL never round-trips
      // exactly. The sweep must still move it.
      const masterId = await seedMaster();
      await pool.query(
        `insert into master_subscriptions (id, master_id, status, current_period_start, current_period_end)
         values (gen_random_uuid(), $1, 'trialing', now() - interval '20 days',
                 now() - interval '6 days' + interval '123 microseconds')`,
        [masterId],
      );

      await subscriptions.expireDue(new Date(), 100);

      expect(await statusOf(masterId)).toBe('expired');
    });

    it('expires instead of entering grace when grace is zero', async () => {
      await pool.query('update subscription_settings set grace_days = 0');
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.enterGrace(baku('2027-04-10T12:00:00'), 100);
      expect((await eventsOf(masterId)).map((e) => e.kind)).toEqual([
        'period_activated',
        'expired',
      ]);
    });

    it('lets a payment in grace start a new period from now', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.enterGrace(baku('2027-04-10T12:00:00'), 100);
      clock.set(baku('2027-04-11T08:00:00'));
      await subscriptions.activatePeriod({
        masterId,
        billingPeriod: 'monthly',
        priceId: monthlyPriceId,
        paymentRef: `pay-${randomUUID()}`,
      });
      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        status: 'active',
        currentPeriodStart: baku('2027-04-11T08:00:00').toISOString(),
        currentPeriodEnd: baku('2027-05-11T08:00:00').toISOString(),
        graceEndsAt: null,
      });
    });

    it('catches a row up with the sweep before a late payment, so the history has no gap', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      // The sweep never ran: the period ended and grace ran out unobserved.
      clock.set(baku('2027-04-20T08:00:00'));
      await subscriptions.activatePeriod({
        masterId,
        billingPeriod: 'monthly',
        priceId: monthlyPriceId,
        paymentRef: `pay-${randomUUID()}`,
      });
      expect((await eventsOf(masterId)).map((e) => [e.kind, e.actor])).toEqual([
        ['period_activated', 'provider'],
        ['expired', 'system'],
        ['period_activated', 'provider'],
      ]);
    });

    it('settles expiry racing a renewal into one consistent answer', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
        await subscriptions.enterGrace(baku('2027-04-10T12:00:00'), 100);
        const graceEnd = baku('2027-04-13T12:00:00');
        clock.set(graceEnd);

        await Promise.all([
          subscriptions.expireDue(graceEnd, 100),
          subscriptions.activatePeriod({
            masterId,
            billingPeriod: 'monthly',
            priceId: monthlyPriceId,
            paymentRef: `pay-${randomUUID()}`,
          }),
        ]);

        const view = await subscriptions.readOwn(masterId);
        expect(view).toMatchObject({
          status: 'active',
          currentPeriodStart: graceEnd.toISOString(),
          entitled: true,
        });
        const kinds = (await eventsOf(masterId)).map((e) => e.kind);
        // Whichever ran first, the grace ended in exactly one expiry and the
        // payment started exactly one period after it.
        expect(kinds).toEqual(['period_activated', 'grace_entered', 'expired', 'period_activated']);
      }
    });
  });

  describe('grants and cancellation', () => {
    it('extends a running period by an admin grant, recording who and why', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.grantPeriod({
        masterId,
        adminUserId: adminId,
        days: 7,
        reason: 'Suspended in error on 12 March.',
      });
      expect((await subscriptions.readOwn(masterId)).currentPeriodEnd).toBe(
        baku('2027-04-17T12:00:00').toISOString(),
      );
      expect((await eventsOf(masterId)).at(-1)).toMatchObject({
        kind: 'period_granted',
        actor: `admin:${adminId}`,
        reason: 'Suspended in error on 12 March.',
        price_id: null,
        payment_ref: null,
      });
    });

    it('starts a grant now for a master with no subscription', async () => {
      const masterId = await seedMaster();
      clock.set(baku('2027-03-10T12:00:00'));
      await subscriptions.grantPeriod({
        masterId,
        adminUserId: adminId,
        days: 30,
        reason: 'Paid in cash at the office.',
      });
      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        status: 'active',
        billingPeriod: null,
        currentPeriodEnd: baku('2027-04-09T12:00:00').toISOString(),
      });
    });

    it('lets a cancelled period run to its end, then expires it without grace', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      clock.set(baku('2027-03-20T12:00:00'));
      await subscriptions.cancel(masterId, { kind: 'system' });

      expect(await subscriptions.readOwn(masterId)).toMatchObject({
        status: 'cancelled',
        entitled: true,
      });
      const end = baku('2027-04-10T12:00:00');
      await subscriptions.enterGrace(end, 100);
      expect(await statusOf(masterId)).toBe('cancelled');
      await subscriptions.expireDue(end, 100);
      expect((await eventsOf(masterId)).map((e) => e.kind)).toEqual([
        'period_activated',
        'cancelled',
        'expired',
      ]);
    });

    it('refuses to cancel a trial, or a subscription already cancelled', async () => {
      const trialing = await seedMaster();
      await subscriptions.startTrial(trialing);
      expect(await errorCodeOf(subscriptions.cancel(trialing, { kind: 'system' }))).toBe(
        'SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
      );

      const active = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.cancel(active, { kind: 'system' });
      expect(await errorCodeOf(subscriptions.cancel(active, { kind: 'system' }))).toBe(
        'SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
      );
      expect(await eventsOf(active)).toHaveLength(2);
    });
  });

  describe('the entitlement predicate, in SQL', () => {
    it('holds until exactly the period end', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      const end = baku('2027-04-10T12:00:00');
      expect(await entitledAt(masterId, new Date(end.getTime() - 1))).toBe(true);
      expect(await entitledAt(masterId, end)).toBe(false);
    });

    it('holds through grace until exactly the grace end', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.enterGrace(baku('2027-04-10T12:00:00'), 100);
      const graceEnd = baku('2027-04-13T12:00:00');
      expect(await entitledAt(masterId, new Date(graceEnd.getTime() - 1))).toBe(true);
      expect(await entitledAt(masterId, graceEnd)).toBe(false);
    });

    it('holds for a cancelled period before its end', async () => {
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await subscriptions.cancel(masterId, { kind: 'system' });
      expect(await entitledAt(masterId, baku('2027-04-01T00:00:00'))).toBe(true);
    });

    it('never holds for a master with no subscription, or an expired one', async () => {
      expect(await entitledAt(await seedMaster(), baku('2027-03-10T12:00:00'))).toBe(false);
      const masterId = await activeMaster(baku('2027-03-10T12:00:00'));
      await pool.query(`update master_subscriptions set status = 'expired' where master_id = $1`, [
        masterId,
      ]);
      expect(await entitledAt(masterId, baku('2027-03-11T00:00:00'))).toBe(false);
    });
  });

  describe('the offer', () => {
    it('reports both current prices, trial, grace and whether purchases are open', async () => {
      clock.set(baku('2027-03-10T12:00:00'));
      expect(await subscriptions.offer()).toEqual({
        monthly: {
          billingPeriod: 'monthly',
          priceMinor: expect.any(Number),
          currency: 'AZN',
          effectiveFrom: expect.any(String),
        },
        yearly: {
          billingPeriod: 'yearly',
          priceMinor: 20_000,
          currency: 'AZN',
          effectiveFrom: baku('2027-01-01T00:00:00').toISOString(),
        },
        trialDays: 14,
        graceDays: 3,
        purchasesOpen: false,
      });
    });

    it('reports a period with no price yet as null', async () => {
      clock.set(baku('2026-12-01T00:00:00'));
      const offer = await subscriptions.offer();
      expect(offer.monthly).toBeNull();
      expect(offer.yearly).toBeNull();
    });
  });
});
