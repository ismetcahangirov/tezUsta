import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionBillingPeriod } from '@tezusta/types';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type {
  SubscriptionCheckoutRow,
  SubscriptionPaymentDisposition,
  SubscriptionPaymentKind,
} from '../../infra/database/schema/subscription-billing';
import {
  subscriptionCheckouts,
  subscriptionPayments,
} from '../../infra/database/schema/subscription-billing';

/** One checkout as reconciliation sees it: what we asked for, and what we recorded. */
export interface ReconciliationCandidate {
  readonly checkoutId: string;
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** A success event for it is on record. */
  readonly recordedPaid: boolean;
  /** A refund event for it is on record. */
  readonly recordedRefund: boolean;
}

/**
 * The SQL behind subscription billing (issue #323). Both tables are
 * append-only, so there is no update here and never will be.
 */
@Injectable()
export class BillingRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Serialises one master's checkout requests, so two at once — a double tap,
   * a retried request — find one checkout rather than opening two. Its own
   * lock rather than the subscription's: it is held across the provider call,
   * and a webhook activating a period must not wait behind that.
   */
  async lockCheckouts(tx: DatabaseExecutor, masterId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tezusta:subscription-checkout:${masterId}`}, 0))`,
    );
  }

  /**
   * The master's newest checkout for this period at this price version, if it
   * was opened after `since` at this provider and nothing has paid it yet —
   * the one a repeated request is handed back. One probe of
   * `subscription_checkouts_master_created_idx`.
   */
  async findReusableCheckout(
    tx: DatabaseExecutor,
    input: {
      readonly masterId: string;
      readonly billingPeriod: SubscriptionBillingPeriod;
      readonly priceId: string;
      readonly provider: string;
      readonly since: Date;
    },
  ): Promise<SubscriptionCheckoutRow | undefined> {
    const [newest] = await tx
      .select()
      .from(subscriptionCheckouts)
      .where(
        and(
          eq(subscriptionCheckouts.masterId, input.masterId),
          gte(subscriptionCheckouts.createdAt, input.since),
        ),
      )
      .orderBy(desc(subscriptionCheckouts.createdAt))
      .limit(1);
    if (
      newest?.billingPeriod !== input.billingPeriod ||
      newest.priceId !== input.priceId ||
      newest.provider !== input.provider
    ) {
      return undefined;
    }
    const [payment] = await tx
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.provider, newest.provider),
          eq(subscriptionPayments.providerRef, newest.providerRef),
          eq(subscriptionPayments.kind, 'succeeded'),
        ),
      )
      .limit(1);
    return payment === undefined ? newest : undefined;
  }

  async insertCheckout(
    tx: DatabaseExecutor,
    row: Omit<SubscriptionCheckoutRow, 'createdAt'> & { readonly createdAt: Date },
  ): Promise<SubscriptionCheckoutRow> {
    const [inserted] = await tx.insert(subscriptionCheckouts).values(row).returning();
    if (inserted === undefined) {
      throw new Error('INSERT … RETURNING returned no checkout row.');
    }
    return inserted;
  }

  async findCheckoutByRef(
    provider: string,
    providerRef: string,
  ): Promise<SubscriptionCheckoutRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptionCheckouts)
      .where(
        and(
          eq(subscriptionCheckouts.provider, provider),
          eq(subscriptionCheckouts.providerRef, providerRef),
        ),
      );
    return row;
  }

  async hasPaymentEvent(provider: string, providerEventId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.provider, provider),
          eq(subscriptionPayments.providerEventId, providerEventId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Records one provider event. **Once:** a second insert of the same
   * `(provider, provider_event_id)` does nothing and returns `false`, which is
   * how a replayed or concurrent delivery is told apart from the first.
   */
  async insertPayment(
    executor: DatabaseExecutor,
    row: {
      readonly provider: string;
      readonly providerEventId: string;
      readonly providerRef: string;
      readonly checkoutId: string | null;
      readonly kind: SubscriptionPaymentKind;
      readonly disposition: SubscriptionPaymentDisposition;
      readonly amountMinor: number | null;
      readonly currency: string | null;
      readonly occurredAt: Date;
    },
  ): Promise<boolean> {
    const inserted = await executor
      .insert(subscriptionPayments)
      .values({ id: uuidV7(), ...row })
      .onConflictDoNothing({
        target: [subscriptionPayments.provider, subscriptionPayments.providerEventId],
      })
      .returning({ id: subscriptionPayments.id });
    return inserted.length > 0;
  }

  /**
   * The checkouts opened at `provider` since `since`, newest first, each with
   * whether a success and a refund are on record. The window over
   * `subscription_checkouts_created_idx`, then one probe of
   * `subscription_payments_provider_ref_idx` per checkout — a lateral rather
   * than `exists`, which the planner would answer by hashing the whole
   * payments table, a table that only grows.
   */
  async listForReconciliation(
    provider: string,
    since: Date,
    limit: number,
  ): Promise<ReconciliationCandidate[]> {
    const result = await this.db.execute<{
      id: string;
      provider_ref: string;
      amount_minor: string | number;
      currency: string;
      recorded_paid: boolean | null;
      recorded_refund: boolean | null;
    }>(sql`
      select c.id, c.provider_ref, c.amount_minor, c.currency,
             recorded.paid as recorded_paid, recorded.refund as recorded_refund
        from (select id, provider, provider_ref, amount_minor, currency, created_at
                from subscription_checkouts
               where provider = ${provider}
                 and created_at >= ${since.toISOString()}::timestamptz
               order by created_at desc
               limit ${limit}) c
        cross join lateral (
          select bool_or(p.kind = 'succeeded') as paid, bool_or(p.kind = 'refunded') as refund
            from subscription_payments p
           where p.provider = c.provider and p.provider_ref = c.provider_ref
        ) recorded
       order by c.created_at desc
    `);
    return result.rows.map((row) => ({
      checkoutId: row.id,
      providerRef: row.provider_ref,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      recordedPaid: row.recorded_paid === true,
      recordedRefund: row.recorded_refund === true,
    }));
  }
}
