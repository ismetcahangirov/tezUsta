/**
 * Gives a seeded master a running subscription, so dispatch offers them work
 * (issue #322).
 *
 * Suites that build a dispatchable master with SQL — an `active`
 * verification status and `is_available = true` — need this as well since
 * the subscription gate joined the dispatch predicate: without it the master
 * is verified and online and still receives nothing. A master approved
 * through the admin surface gets a trial on their own; this is for the ones
 * that skip it.
 *
 * An `active` monthly period running from now for thirty days, with no event
 * row: suites that are not about subscriptions do not read the history, and
 * the subscription suite seeds through `SubscriptionsService` instead. A
 * master who already has a subscription keeps it.
 */
export async function grantTestSubscription(
  pool: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  masterId: string,
): Promise<void> {
  await pool.query(
    `insert into master_subscriptions
       (id, master_id, status, billing_period, current_period_start, current_period_end)
     values (gen_random_uuid(), $1, 'active', 'monthly', now(), now() + interval '30 days')
     on conflict (master_id) do nothing`,
    [masterId],
  );
}
