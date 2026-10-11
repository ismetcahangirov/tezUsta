import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionBillingPeriod } from '@tezusta/types';
import { and, asc, eq, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type {
  MasterSubscriptionRow,
  SubscriptionPriceRow,
  SubscriptionSettingsRow,
} from '../../infra/database/schema/subscriptions';
import {
  masterSubscriptions,
  subscriptionEvents,
  subscriptionPrices,
  subscriptionSettings,
} from '../../infra/database/schema/subscriptions';
import { subscriptionEntitlement } from './subscription-entitlement';
import type { SubscriptionState, TransitionEvent } from './subscription-transitions';

/** Who caused a subscription event, as `subscription_events.actor` stores it. */
export type SubscriptionActor =
  | { readonly kind: 'system' }
  | { readonly kind: 'provider' }
  | { readonly kind: 'admin'; readonly adminUserId: string };

function actorColumn(actor: SubscriptionActor): string {
  return actor.kind === 'admin' ? `admin:${actor.adminUserId}` : actor.kind;
}

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
   * Each period's current price: its newest version whose `effective_from`
   * has passed. One `distinct on` over `subscription_prices_period_effective_idx`.
   */
  async currentPrices(at: Date): Promise<SubscriptionPriceRow[]> {
    const result = await this.db.execute<{
      id: string;
      billing_period: SubscriptionBillingPeriod;
      price_minor: string;
      currency: string;
      effective_from: Date | string;
      created_by_admin_id: string;
      created_at: Date | string;
    }>(sql`
      select distinct on (billing_period)
             id, billing_period, price_minor, currency, effective_from,
             created_by_admin_id, created_at
        from subscription_prices
       where effective_from <= ${at.toISOString()}::timestamptz
       order by billing_period, effective_from desc
    `);
    return result.rows.map((row) => ({
      id: row.id,
      billingPeriod: row.billing_period,
      priceMinor: Number(row.price_minor),
      currency: row.currency,
      effectiveFrom: new Date(row.effective_from),
      createdByAdminId: row.created_by_admin_id,
      createdAt: new Date(row.created_at),
    }));
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
