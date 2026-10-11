import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionBillingPeriod, SubscriptionStatus } from '@tezusta/types';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type {
  MasterSubscriptionRow,
  SubscriptionEventRow,
  SubscriptionNoticeKind,
  SubscriptionPriceRow,
  SubscriptionSettingsRow,
} from '../../infra/database/schema/subscriptions';
import {
  masterSubscriptions,
  subscriptionEvents,
  subscriptionNotices,
  subscriptionPrices,
  subscriptionSettings,
} from '../../infra/database/schema/subscriptions';
import { subscriptionEntitlement } from './subscription-entitlement';
import type { SubscriptionState, TransitionEvent } from './subscription-transitions';

/**
 * A version that counts as a price: not a withdrawal row, and not withdrawn
 * by one (#324). Against `subscription_prices p`.
 */
const LIVE_PRICE = sql`p.withdraws_price_id is null
         and not exists (
           select 1 from subscription_prices w where w.withdraws_price_id = p.id
         )`;

const PRICE_COLUMNS = sql`p.id, p.billing_period, p.price_minor, p.currency, p.effective_from,
             p.created_by_admin_id, p.withdraws_price_id, p.created_at`;

/** A raw `subscription_prices` row, as `db.execute` hands it back. */
type PriceSqlRow = {
  id: string;
  billing_period: SubscriptionBillingPeriod;
  price_minor: string | number | null;
  currency: string;
  effective_from: Date | string;
  created_by_admin_id: string;
  withdraws_price_id: string | null;
  created_at: Date | string;
};

function toPriceRow(row: PriceSqlRow): SubscriptionPriceRow {
  return {
    id: row.id,
    billingPeriod: row.billing_period,
    priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    currency: row.currency,
    effectiveFrom: new Date(row.effective_from),
    createdByAdminId: row.created_by_admin_id,
    withdrawsPriceId: row.withdraws_price_id,
    createdAt: new Date(row.created_at),
  };
}

/** Who caused a subscription event, as `subscription_events.actor` stores it. */
export type SubscriptionActor =
  | { readonly kind: 'system' }
  | { readonly kind: 'provider' }
  | { readonly kind: 'admin'; readonly adminUserId: string };

function actorColumn(actor: SubscriptionActor): string {
  return actor.kind === 'admin' ? `admin:${actor.adminUserId}` : actor.kind;
}

/**
 * Writes the admin audit row for a subscription change, inside the change's
 * own transaction (#324) — the same shape as the catalogue's recorder, so the
 * admin module supplies one writer for both.
 */
export type SubscriptionAuditRecorder = (
  tx: DatabaseExecutor,
  change: {
    readonly targetId: string;
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
  },
) => Promise<void>;

/** What a paid event carries beyond the transition itself. */
export interface EventPayment {
  readonly priceId: string;
  readonly amountMinor: number;
  readonly paymentRef: string;
}

/** The state-machine columns of a row, in the shape the pure transitions take. */
export function toState(row: MasterSubscriptionRow): SubscriptionState {
  return {
    status: row.status,
    billingPeriod: row.billingPeriod,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    nextBillingPeriod: row.nextBillingPeriod,
    cancelledAt: row.cancelledAt,
  };
}

/**
 * The SQL behind the subscription (issue #322). No business rules here: the
 * state machine is `subscription-transitions.ts`, and `SubscriptionsService`
 * decides when each piece runs.
 */
@Injectable()
export class SubscriptionsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Serialises every write to one master's subscription, **including the
   * first one**, when there is no row yet to `FOR UPDATE`. Two confirmations of
   * the same payment arriving together are the case that needs it: without a
   * lock both would find no event for the reference and both would extend the
   * period. Transaction-scoped: released at commit or rollback.
   */
  async lockMaster(tx: DatabaseExecutor, masterId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tezusta:subscription:${masterId}`}, 0))`,
    );
  }

  async readSettings(executor: DatabaseExecutor = this.db): Promise<SubscriptionSettingsRow> {
    const [row] = await executor
      .select()
      .from(subscriptionSettings)
      .where(eq(subscriptionSettings.id, 1));
    if (row === undefined) {
      // The migration seeds it and a trigger refuses its deletion.
      throw new Error('subscription_settings has no row: migration 0038 did not run.');
    }
    return row;
  }

  async findByMasterId(
    masterId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<MasterSubscriptionRow | undefined> {
    const [row] = await executor
      .select()
      .from(masterSubscriptions)
      .where(eq(masterSubscriptions.masterId, masterId));
    return row;
  }

  /** The entitlement, asked of one master by the database's own clock. */
  async isEntitled(masterId: string): Promise<boolean> {
    const result = await this.db.execute<{ entitled: boolean }>(
      sql`select ${subscriptionEntitlement(sql`${masterId}::uuid`)} as entitled`,
    );
    return result.rows[0]?.entitled === true;
  }

  async findPrice(
    priceId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<SubscriptionPriceRow | undefined> {
    const [row] = await executor
      .select()
      .from(subscriptionPrices)
      .where(eq(subscriptionPrices.id, priceId));
    return row;
  }

  /**
   * Each period's current price: its newest live version whose
   * `effective_from` has passed, the most recently entered first on a tie.
   * "Live" leaves out a withdrawal row and the version it withdrew (#324).
   * One `distinct on` over `subscription_prices_period_effective_idx`.
   */
  async currentPrices(
    at: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<SubscriptionPriceRow[]> {
    const result = await executor.execute<PriceSqlRow>(sql`
      select distinct on (p.billing_period) ${PRICE_COLUMNS}
        from subscription_prices p
       where p.effective_from <= ${at.toISOString()}::timestamptz
         and ${LIVE_PRICE}
       order by p.billing_period, p.effective_from desc, p.created_at desc
    `);
    return result.rows.map(toPriceRow);
  }

  /** Each period's live version entered for a later date, if there is one. */
  async scheduledPrices(
    at: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<SubscriptionPriceRow[]> {
    const result = await executor.execute<PriceSqlRow>(sql`
      select ${PRICE_COLUMNS}
        from subscription_prices p
       where p.effective_from > ${at.toISOString()}::timestamptz
         and ${LIVE_PRICE}
       order by p.billing_period, p.effective_from, p.created_at
    `);
    return result.rows.map(toPriceRow);
  }

  /** Every version ever entered, newest entered first — the admin's price history. */
  async priceHistory(limit: number): Promise<SubscriptionPriceRow[]> {
    return this.db
      .select()
      .from(subscriptionPrices)
      .orderBy(desc(subscriptionPrices.createdAt), desc(subscriptionPrices.id))
      .limit(limit);
  }

  /** The ids of every version a withdrawal row withdrew. */
  async withdrawnPriceIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: subscriptionPrices.withdrawsPriceId })
      .from(subscriptionPrices)
      .where(isNotNull(subscriptionPrices.withdrawsPriceId));
    return new Set(rows.flatMap((row) => (row.id === null ? [] : [row.id])));
  }

  /**
   * Serialises every edit of the offer — prices and settings — so "is a
   * price already scheduled?" is answered and acted on as one step.
   * Transaction-scoped.
   */
  async lockOffer(tx: DatabaseExecutor): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tezusta:subscription-offer'))`);
  }

  async insertPrice(
    tx: DatabaseExecutor,
    input: {
      readonly billingPeriod: SubscriptionBillingPeriod;
      readonly priceMinor: number | null;
      readonly effectiveFrom: Date;
      readonly adminUserId: string;
      readonly withdrawsPriceId?: string;
      readonly now: Date;
    },
  ): Promise<SubscriptionPriceRow> {
    const [row] = await tx
      .insert(subscriptionPrices)
      .values({
        id: uuidV7(),
        billingPeriod: input.billingPeriod,
        priceMinor: input.priceMinor,
        effectiveFrom: input.effectiveFrom,
        createdByAdminId: input.adminUserId,
        withdrawsPriceId: input.withdrawsPriceId ?? null,
        createdAt: input.now,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Inserting a subscription price returned no row.');
    }
    return row;
  }

  /** Whether anyone has ever paid for this billing period — what decides whether a change needs notice. */
  async hasBeenPaid(
    billingPeriod: SubscriptionBillingPeriod,
    executor: DatabaseExecutor = this.db,
  ): Promise<boolean> {
    const result = await executor.execute<{ paid: boolean }>(sql`
      select exists (
        select 1
          from subscription_events e
          join subscription_prices p on p.id = e.price_id
         where p.billing_period = ${billingPeriod}
      ) as paid
    `);
    return result.rows[0]?.paid === true;
  }

  async updateSettings(
    tx: DatabaseExecutor,
    patch: {
      readonly trialDays?: number | undefined;
      readonly graceDays?: number | undefined;
      readonly purchasesOpen?: boolean | undefined;
    },
    adminUserId: string,
    now: Date,
  ): Promise<SubscriptionSettingsRow> {
    const [row] = await tx
      .update(subscriptionSettings)
      .set({
        ...(patch.trialDays === undefined ? {} : { trialDays: patch.trialDays }),
        ...(patch.graceDays === undefined ? {} : { graceDays: patch.graceDays }),
        ...(patch.purchasesOpen === undefined ? {} : { purchasesOpen: patch.purchasesOpen }),
        updatedAt: now,
        updatedByAdminId: adminUserId,
      })
      .where(eq(subscriptionSettings.id, 1))
      .returning();
    if (row === undefined) {
      throw new Error('subscription_settings has no row: migration 0038 did not run.');
    }
    return row;
  }

  /** One master's history, newest first. */
  async listEvents(subscriptionId: string, limit: number): Promise<SubscriptionEventRow[]> {
    return this.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.masterSubscriptionId, subscriptionId))
      .orderBy(desc(subscriptionEvents.createdAt), desc(subscriptionEvents.id))
      .limit(limit);
  }

  /**
   * Claims one push in the ledger (#326). `true` the first time, `false` for
   * every claim after it — the unique key decides, so two sweeps, a retry or a
   * concurrent payment confirmation cannot both win.
   */
  async claimNotice(
    executor: DatabaseExecutor,
    masterSubscriptionId: string,
    kind: SubscriptionNoticeKind,
    dedupKey: string,
  ): Promise<boolean> {
    const rows = await executor
      .insert(subscriptionNotices)
      .values({ id: uuidV7(), masterSubscriptionId, kind, dedupKey })
      .onConflictDoNothing()
      .returning({ id: subscriptionNotices.id });
    return rows.length > 0;
  }

  /**
   * Periods ending within the warning window with nothing queued after them,
   * whose warning has not been sent (#326). The not-exists is in the query, so
   * a batch is all new work and the sweep's short-batch stop is honest. The
   * ledger key is the period end in epoch milliseconds, computed the same way
   * here and in `noticeKey`.
   */
  async listEndingSoon(
    now: Date,
    until: Date,
    limit: number,
  ): Promise<
    {
      id: string;
      masterId: string;
      billingPeriod: SubscriptionBillingPeriod | null;
      currentPeriodEnd: Date;
    }[]
  > {
    return this.db
      .select({
        id: masterSubscriptions.id,
        masterId: masterSubscriptions.masterId,
        billingPeriod: masterSubscriptions.billingPeriod,
        currentPeriodEnd: masterSubscriptions.currentPeriodEnd,
      })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} <> 'expired'
            and ${masterSubscriptions.status} in ('trialing', 'active', 'cancelled')
            and ${masterSubscriptions.nextBillingPeriod} is null
            and ${masterSubscriptions.currentPeriodEnd} > ${now}
            and ${masterSubscriptions.currentPeriodEnd} <= ${until}
            and not exists (
              select 1 from subscription_notices n
               where n.master_subscription_id = ${masterSubscriptions.id}
                 and n.kind = 'ending'
                 and n.dedup_key = floor(extract(epoch from ${masterSubscriptions.currentPeriodEnd}) * 1000)::bigint::text
            )`,
      )
      .orderBy(asc(masterSubscriptions.currentPeriodEnd))
      .limit(limit);
  }

  /**
   * One page of the subscriptions a price change on `billingPeriod` reaches
   * (#326): running or in grace, on that period now or queued to it. A
   * cancelled subscription does not renew, so a new price never reaches it.
   * Keyset-paged by id.
   */
  async listOnBillingPeriod(
    billingPeriod: SubscriptionBillingPeriod,
    afterId: string | null,
    limit: number,
  ): Promise<{ id: string; masterId: string }[]> {
    return this.db
      .select({ id: masterSubscriptions.id, masterId: masterSubscriptions.masterId })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} in ('trialing', 'active', 'past_due')
            and (${masterSubscriptions.billingPeriod} = ${billingPeriod}
                 or ${masterSubscriptions.nextBillingPeriod} = ${billingPeriod})
            ${afterId === null ? sql`` : sql`and ${masterSubscriptions.id} > ${afterId}`}`,
      )
      .orderBy(asc(masterSubscriptions.id))
      .limit(limit);
  }

  /** The subscription status of each of these masters; a master with none is absent. */
  async statusesFor(masterIds: readonly string[]): Promise<Map<string, SubscriptionStatus>> {
    if (masterIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ masterId: masterSubscriptions.masterId, status: masterSubscriptions.status })
      .from(masterSubscriptions)
      .where(inArray(masterSubscriptions.masterId, [...masterIds]));
    return new Map(rows.map((row) => [row.masterId, row.status]));
  }

  /**
   * The dashboard's counters, as of `now`. Running periods only for the
   * active counts — a row the sweep has not reached yet is not counted as
   * active past its end.
   */
  async dashboardCounts(now: Date): Promise<{
    trialing: number;
    activeMonthly: number;
    activeYearly: number;
    activeGranted: number;
    inGrace: number;
    expiredLast7Days: number;
  }> {
    const at = sql`${now.toISOString()}::timestamptz`;
    const result = await this.db.execute<{
      trialing: number;
      active_monthly: number;
      active_yearly: number;
      active_granted: number;
      in_grace: number;
      expired_last_7_days: number;
    }>(sql`
      select
        count(*) filter (where s.status = 'trialing' and s.current_period_end > ${at})::int as trialing,
        count(*) filter (where s.status in ('active', 'cancelled') and s.billing_period = 'monthly'
                           and s.current_period_end > ${at})::int as active_monthly,
        count(*) filter (where s.status in ('active', 'cancelled') and s.billing_period = 'yearly'
                           and s.current_period_end > ${at})::int as active_yearly,
        count(*) filter (where s.status in ('active', 'cancelled') and s.billing_period is null
                           and s.current_period_end > ${at})::int as active_granted,
        count(*) filter (where s.grace_ends_at is not null and s.grace_ends_at > ${at}
                           and s.status in ('past_due', 'cancelled')
                           and s.current_period_end <= ${at})::int as in_grace,
        (select count(distinct e.master_subscription_id)::int
           from subscription_events e
          where e.kind = 'expired'
            and e.created_at > ${at} - interval '7 days'
            and e.created_at <= ${at}) as expired_last_7_days
        from master_subscriptions s
       where s.status <> 'expired'
    `);
    const row = result.rows[0];
    return {
      trialing: row?.trialing ?? 0,
      activeMonthly: row?.active_monthly ?? 0,
      activeYearly: row?.active_yearly ?? 0,
      activeGranted: row?.active_granted ?? 0,
      inGrace: row?.in_grace ?? 0,
      expiredLast7Days: row?.expired_last_7_days ?? 0,
    };
  }

  async hasPaymentRef(paymentRef: string, executor: DatabaseExecutor): Promise<boolean> {
    const rows = await executor
      .select({ id: subscriptionEvents.id })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.paymentRef, paymentRef))
      .limit(1);
    return rows.length > 0;
  }

  /** The first row for a master. Returns `undefined` if one already exists. */
  async insert(
    tx: DatabaseExecutor,
    masterId: string,
    state: SubscriptionState,
    now: Date,
  ): Promise<MasterSubscriptionRow | undefined> {
    const [row] = await tx
      .insert(masterSubscriptions)
      .values({ id: uuidV7(), masterId, ...state, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: masterSubscriptions.masterId })
      .returning();
    return row;
  }

  /**
   * Moves a row from `from` to `next` — **only if it is still in `from`'s
   * status**, so a write that lost a race changes nothing and reports
   * `undefined` instead of overwriting the winner. The master's advisory lock
   * is what actually serialises writers; this is the backstop.
   *
   * The status, and not the period end: a row written by SQL `now()` carries
   * microseconds, a JavaScript `Date` read back from it does not, and an
   * equality on the timestamp would never match such a row again.
   */
  async update(
    tx: DatabaseExecutor,
    id: string,
    from: SubscriptionState,
    next: SubscriptionState,
    now: Date,
  ): Promise<MasterSubscriptionRow | undefined> {
    const [row] = await tx
      .update(masterSubscriptions)
      .set({ ...next, updatedAt: now })
      .where(and(eq(masterSubscriptions.id, id), eq(masterSubscriptions.status, from.status)))
      .returning();
    return row;
  }

  async appendEvent(
    tx: DatabaseExecutor,
    input: {
      readonly masterSubscriptionId: string;
      readonly event: TransitionEvent;
      readonly actor: SubscriptionActor;
      readonly reason?: string | undefined;
      readonly payment?: EventPayment | undefined;
      readonly now: Date;
    },
  ): Promise<void> {
    const { event, payment } = input;
    await tx.insert(subscriptionEvents).values({
      id: uuidV7(),
      masterSubscriptionId: input.masterSubscriptionId,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      periodStart: event.periodStart,
      periodEnd: event.periodEnd,
      billingPeriod: event.billingPeriod,
      priceId: payment?.priceId ?? null,
      amountMinor: payment?.amountMinor ?? null,
      paymentRef: payment?.paymentRef ?? null,
      actor: actorColumn(input.actor),
      reason: input.reason ?? null,
      createdAt: input.now,
    });
  }

  /*
   * The sweep's due lists, each ordered by and bounded on a partial index.
   * Every one repeats `status <> 'expired'` literally: that is the partial
   * indexes' own predicate, and Postgres only uses a partial index for a query
   * whose WHERE clause provably implies it — `status = 'active'` alone does
   * not prove it to the planner. Each returns master ids; the service locks
   * and re-checks every row before moving it.
   */

  /** A running period has ended and a paid one is queued behind it. */
  async listQueuedDue(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ masterId: masterSubscriptions.masterId })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} <> 'expired'
            and ${masterSubscriptions.status} in ('trialing', 'active', 'cancelled')
            and ${masterSubscriptions.nextBillingPeriod} is not null
            and ${masterSubscriptions.currentPeriodEnd} <= ${now}`,
      )
      .orderBy(asc(masterSubscriptions.currentPeriodEnd))
      .limit(limit);
    return rows.map((row) => row.masterId);
  }

  /** An active period has ended with nothing queued: due to enter grace. */
  async listGraceDue(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ masterId: masterSubscriptions.masterId })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} <> 'expired'
            and ${masterSubscriptions.status} = 'active'
            and ${masterSubscriptions.nextBillingPeriod} is null
            and ${masterSubscriptions.currentPeriodEnd} <= ${now}`,
      )
      .orderBy(asc(masterSubscriptions.currentPeriodEnd))
      .limit(limit);
    return rows.map((row) => row.masterId);
  }

  /** A trial or a cancelled period has ended, with no grace and nothing queued. */
  async listPeriodExpiryDue(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ masterId: masterSubscriptions.masterId })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} <> 'expired'
            and ${masterSubscriptions.status} in ('trialing', 'cancelled')
            and ${masterSubscriptions.graceEndsAt} is null
            and ${masterSubscriptions.nextBillingPeriod} is null
            and ${masterSubscriptions.currentPeriodEnd} <= ${now}`,
      )
      .orderBy(asc(masterSubscriptions.currentPeriodEnd))
      .limit(limit);
    return rows.map((row) => row.masterId);
  }

  /** Grace has run out. */
  async listGraceExpiryDue(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ masterId: masterSubscriptions.masterId })
      .from(masterSubscriptions)
      .where(
        sql`${masterSubscriptions.status} <> 'expired'
            and ${masterSubscriptions.graceEndsAt} is not null
            and ${masterSubscriptions.status} in ('past_due', 'cancelled')
            and ${masterSubscriptions.graceEndsAt} <= ${now}`,
      )
      .orderBy(asc(masterSubscriptions.graceEndsAt))
      .limit(limit);
    return rows.map((row) => row.masterId);
  }
}
