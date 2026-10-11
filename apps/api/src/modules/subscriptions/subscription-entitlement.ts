import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * **The** subscription entitlement, as SQL (ADR-0046 § 5, issue #322).
 *
 * One predicate, used everywhere the question is asked: the dispatch
 * broadcast and the accept re-check (`nearby-masters.repository.ts`), and
 * `SubscriptionsRepository.isEntitled` behind going available. Written once
 * so the three cannot drift — the same reason `masterEligibilityTerms` exists.
 *
 * A master is entitled while their subscription is not `expired` and `at` is
 * before the end of their grace, or of their period when there is no grace.
 * `cancelled` is entitled too: a cancelled period runs to its end and only
 * stops renewing. `subscription-transitions.ts#isEntitled` is the same rule in
 * TypeScript.
 *
 * An `exists` over `master_subscriptions_master_unique`, so per candidate it is
 * one index probe and never a scan. `at` defaults to the statement's `now()`,
 * the clock the rest of the dispatch query already uses.
 */
export function subscriptionEntitlement(masterId: SQL, at: SQL = sql`now()`): SQL {
  return sql`exists (
        select 1
          from master_subscriptions sub
         where sub.master_id = ${masterId}
           and sub.status in ('trialing', 'active', 'past_due', 'cancelled')
           and ${at} < coalesce(sub.grace_ends_at, sub.current_period_end)
      )`;
}
