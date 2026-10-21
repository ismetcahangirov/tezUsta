import { Inject, Injectable } from '@nestjs/common';
import type { SubscriptionBillingPeriod } from '@tezusta/types';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';

import type { SecretBox } from '../../common/crypto/secret-box';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { PAYMENT_TOKEN_BOX, paymentTokenContext } from '../../infra/billing/payment-token-box';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type {
  SubscriptionCheckoutRow,
  SubscriptionPaymentDisposition,
  SubscriptionPaymentKind,
  SubscriptionPaymentMethodRow,
} from '../../infra/database/schema/subscription-billing';
import {
  subscriptionCheckouts,
  subscriptionPaymentMethods,
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

/** A period due for renewal on a saved card. */
export interface RenewalCandidate {
  readonly masterId: string;
  readonly billingPeriod: SubscriptionBillingPeriod;
  readonly currentPeriodEnd: Date;
  readonly paymentMethodId: string;
  /** The provider's token, opened. Never logged. */
  readonly tokenRef: string;
}

/**
 * The SQL behind subscription billing (issue #323). Checkouts and payments
 * are append-only; a saved card is only ever revoked.
 *
 * **A saved card's token is sealed here and opened here** (#424): it is
 * written and read only through this class, under AES-256-GCM with the row's
 * own id as context, so `token_ref` in the database is never the token.
 */
@Injectable()
export class BillingRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(PAYMENT_TOKEN_BOX) private readonly tokens: SecretBox,
  ) {}

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
   * The master's newest checkout for this period at this price version, with
   * the same auto-renewal choice, if it is a hosted one opened after `since`
   * at this provider and nothing has paid it yet —
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
      readonly saveCard: boolean;
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
      newest?.kind !== 'hosted' ||
      newest.billingPeriod !== input.billingPeriod ||
      newest.priceId !== input.priceId ||
      newest.provider !== input.provider ||
      newest.saveCard !== input.saveCard
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

  /*
   * Auto-renewal (ADR-0058).
   */

  /** The master's live saved card at `provider`, if any. */
  async findLivePaymentMethod(
    masterId: string,
    provider: string,
  ): Promise<SubscriptionPaymentMethodRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptionPaymentMethods)
      .where(
        and(
          eq(subscriptionPaymentMethods.masterId, masterId),
          eq(subscriptionPaymentMethods.provider, provider),
          isNull(subscriptionPaymentMethods.revokedAt),
        ),
      );
    return row;
  }

  /**
   * Keeps the card a master saved at checkout, replacing any card saved
   * before it. A replayed event carrying the live token changes nothing.
   * Under the master's checkout lock, so two successes at once leave one
   * live card.
   */
  async savePaymentMethod(input: {
    readonly masterId: string;
    readonly provider: string;
    readonly tokenRef: string;
    readonly now: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockCheckouts(tx, input.masterId);
      const [live] = await tx
        .select({
          id: subscriptionPaymentMethods.id,
          tokenRef: subscriptionPaymentMethods.tokenRef,
        })
        .from(subscriptionPaymentMethods)
        .where(
          and(
            eq(subscriptionPaymentMethods.masterId, input.masterId),
            isNull(subscriptionPaymentMethods.revokedAt),
          ),
        );
      if (live !== undefined && this.openToken(live.id, live.tokenRef) === input.tokenRef) {
        return;
      }
      if (live !== undefined) {
        await tx
          .update(subscriptionPaymentMethods)
          .set({ revokedAt: input.now, revokedReason: 'replaced' })
          .where(eq(subscriptionPaymentMethods.id, live.id));
      }
      const id = uuidV7();
      await tx.insert(subscriptionPaymentMethods).values({
        id,
        masterId: input.masterId,
        provider: input.provider,
        tokenRef: this.tokens.seal(Buffer.from(input.tokenRef, 'utf8'), paymentTokenContext(id)),
        createdAt: input.now,
      });
    });
  }

  /** The master turned auto-renewal off. `false` when there was nothing to revoke. */
  async revokePaymentMethod(masterId: string, now: Date): Promise<boolean> {
    const revoked = await this.db
      .update(subscriptionPaymentMethods)
      .set({ revokedAt: now, revokedReason: 'master' })
      .where(
        and(
          eq(subscriptionPaymentMethods.masterId, masterId),
          isNull(subscriptionPaymentMethods.revokedAt),
        ),
      )
      .returning({ id: subscriptionPaymentMethods.id });
    return revoked.length > 0;
  }

  /** Has this period already been charged for renewal? Under the checkout lock. */
  async hasRenewalFor(tx: DatabaseExecutor, masterId: string, periodEnd: Date): Promise<boolean> {
    const rows = await tx
      .select({ id: subscriptionCheckouts.id })
      .from(subscriptionCheckouts)
      .where(
        and(
          eq(subscriptionCheckouts.masterId, masterId),
          eq(subscriptionCheckouts.kind, 'renewal'),
          eq(subscriptionCheckouts.renewsPeriodEnd, periodEnd),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Periods ending in `(now, until]` that auto-renewal should charge: an
   * `active` subscription (not a trial, not cancelled, not in grace) with
   * nothing queued, a verified master, a live card at this provider saved
   * **after** any cancellation, and no renewal charged for this period yet.
   *
   * Over `master_subscriptions_period_end_due_idx`, whose `status <>
   * 'expired'` predicate is repeated literally so the planner can use it.
   */
  async listRenewalCandidates(
    provider: string,
    now: Date,
    until: Date,
    limit: number,
  ): Promise<RenewalCandidate[]> {
    const result = await this.db.execute<{
      master_id: string;
      billing_period: SubscriptionBillingPeriod;
      current_period_end: Date | string;
      payment_method_id: string;
      token_ref: string;
    }>(sql`
      select s.master_id, s.billing_period, s.current_period_end,
             pm.id as payment_method_id, pm.token_ref
        from master_subscriptions s
        join subscription_payment_methods pm
          on pm.master_id = s.master_id and pm.revoked_at is null and pm.provider = ${provider}
        join masters m
          on m.id = s.master_id and m.verification_status = 'active' and m.deleted_at is null
       where s.status <> 'expired'
         and s.status = 'active'
         and s.next_billing_period is null
         and s.billing_period is not null
         and s.current_period_end > ${now.toISOString()}::timestamptz
         and s.current_period_end <= ${until.toISOString()}::timestamptz
         and not exists (
           select 1 from subscription_checkouts c
            where c.master_id = s.master_id and c.kind = 'renewal'
              and c.renews_period_end = s.current_period_end
         )
         and not exists (
           select 1 from subscription_events e
            where e.master_subscription_id = s.id and e.kind = 'cancelled'
              and e.created_at > pm.created_at
         )
       order by s.current_period_end
       limit ${limit}
    `);
    return result.rows
      .map((row) => ({
        masterId: row.master_id,
        billingPeriod: row.billing_period,
        currentPeriodEnd: new Date(row.current_period_end),
        paymentMethodId: row.payment_method_id,
        tokenRef: this.openToken(row.payment_method_id, row.token_ref) ?? '',
      }))
      .filter((candidate) => candidate.tokenRef !== '');
  }

  /**
   * A saved card's token, or `undefined` when it cannot be opened — sealed
   * under another key (a stub's per-process key after a restart, or a
   * rotated key) or tampered with. Such a card is simply never charged.
   */
  private openToken(paymentMethodId: string, sealed: string): string | undefined {
    try {
      return this.tokens.open(sealed, paymentTokenContext(paymentMethodId)).toString('utf8');
    } catch {
      return undefined;
    }
  }
}
