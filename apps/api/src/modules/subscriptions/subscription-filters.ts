import type { SubscriptionStatus } from '@tezusta/types';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/** A subscription status to filter by, or `none` for a master with no subscription yet. */
export type SubscriptionStatusFilter = SubscriptionStatus | 'none';

/**
 * "This master's subscription is in `status`", as SQL against another
 * module's query (#324): the admin masters list filters by it.
 *
 * Here, beside the table, for the reason `subscription-entitlement.ts` is: the
 * masters module asks the question without writing SQL against a table it
 * does not own. One probe of `master_subscriptions_master_unique` per row.
 */
export function masterSubscriptionStatusIs(masterId: SQL, status: SubscriptionStatusFilter): SQL {
  if (status === 'none') {
    return sql`not exists (
        select 1 from master_subscriptions sub where sub.master_id = ${masterId}
      )`;
  }
  return sql`exists (
      select 1 from master_subscriptions sub
       where sub.master_id = ${masterId} and sub.status = ${status}
    )`;
}
