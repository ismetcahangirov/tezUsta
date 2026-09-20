import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../infra/database/database.types';

/**
 * The measurement ADR-0009 § Parameters is waiting for (issue #114).
 *
 * ADR-0009 fixes five dispatch parameters and says, in as many words, that
 * they are *hypotheses* to be replaced with measured values. Issue #114 is
 * what keeps that sentence from rotting, and it is **blocked on traffic**:
 * every one of the five is a claim about supply — how densely masters stand in
 * Baku, how long one takes to notice an offer, how many offers become noise —
 * and none of that is knowable until masters are using the app against real
 * orders. Deriving them from seeded fixtures would produce numbers that look
 * measured and are not, which #114 itself calls worse than an honest
 * hypothesis.
 *
 * **What was not blocked is the query.** #114's technical notes say the
 * measurement "needs no new columns, only a query" — and that query did not
 * exist, so the issue was blocked twice over: once on traffic, and once on
 * somebody deriving the SQL under pressure on the first day of a pilot, from
 * tables whose meaning has to be reconstructed from the engine's source. This
 * file is that query, written while there is time to get it right. It measures
 * nothing today, because there is nothing to measure; it is what turns the
 * first real orders into the five numbers without a second thought.
 *
 * **It derives no parameter value and recommends none.** Every output here is
 * an observed distribution over rows that exist. Which value to ship is a
 * judgement about the trade-off each parameter makes, and belongs in the ADR
 * that supersedes ADR-0009 § Parameters, next to the evidence — not in code
 * that could be mistaken for having decided.
 *
 * **Offline, and deliberately unindexed for.** This is run by hand against a
 * bounded window, never on a request path, so CLAUDE.md §12's "no unindexed
 * query on a hot path" is satisfied by it not being on one. Adding an index to
 * `order_status_history` for its sake would slow down every order transition
 * in production to speed up a report somebody runs once a week, which is the
 * wrong trade. The window is required rather than defaulted to "everything"
 * for the same reason.
 *
 * **There is no controller and no HTTP route.** Dispatch outcomes are
 * commercially sensitive and say where masters are; exposing them would need
 * the admin authentication ADR-0014 describes and a reason to have them in a
 * browser. Neither exists, and a report nobody can reach over the network is a
 * report that cannot leak.
 */

/**
 * The half-open window a report covers: searches that **began** at or after
 * `from` and before `to`.
 *
 * Attributed by when the search started rather than when it ended, so a search
 * is counted once, in the window it belongs to, even though its outcome lands
 * later. A window narrower than `DISPATCH_TOTAL_TIMEOUT_SECONDS` from `now`
 * will therefore contain searches that had not finished when the report ran —
 * which is what `stillOpen` below is for.
 */
export interface DispatchMetricsWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * An observed distribution. `null` everywhere but `count` when nothing was
 * observed — an empty window must read as "no data", never as zero.
 *
 * Percentiles rather than a mean alone: every one of ADR-0009's parameters is
 * a bound on a tail. A mean time-to-accept of 40 seconds says nothing about
 * whether a 180-second window is generous or tight; p95 does.
 */
export interface Distribution {
  /** How many non-null observations the percentiles were taken over. */
  readonly count: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

/**
 * One **search**, not one order: a re-dispatch (ADR-0015) starts a second
 * search of the same order, with its own rounds and its own outcome, and
 * counting it as part of the first would understate both the give-up rate and
 * the time an accept takes.
 */
export interface DispatchSearchMetrics {
  readonly searches: number;
  readonly accepted: number;
  readonly noMasterFound: number;
  readonly cancelled: number;
  /** Ended in some other status — a re-dispatch loop, or an admin action. */
  readonly otherOutcome: number;
  /** Still `SEARCHING` when the report ran. Excluded from every rate below. */
  readonly stillOpen: number;
  /**
   * `noMasterFound / (accepted + noMasterFound)`.
   *
   * Cancelled and still-open searches are out of the denominator on purpose: a
   * customer who cancelled while searching did not tell us whether a master
   * would have come, and neither did a search that has not finished. Including
   * them would make the rate a function of customer patience rather than of
   * supply, which is the thing being measured. `null` when nothing finished.
   */
  readonly noMasterFoundRate: number | null;
  /**
   * Seconds from entering `SEARCHING` to the accept. **The evidence for
   * `DISPATCH_TOTAL_TIMEOUT_SECONDS`** — a timeout below p95 gives up on
   * searches that would have been accepted.
   */
  readonly timeToAcceptSeconds: Distribution;
  /**
   * The round the accepting master was reached on. **Evidence for
   * `DISPATCH_RADIUS_STEP_SECONDS`**: accepts clustered in round 1 mean the
   * initial radius already holds the supply and widening is mostly wasted
   * broadcast; a long tail means the opposite.
   */
  readonly acceptRound: Distribution;
  /** The radius the accepting round broadcast at, in metres. */
  readonly acceptRadiusM: Distribution;
  /**
   * How far the accepting master actually stood, in metres. **Evidence for
   * `DISPATCH_INITIAL_RADIUS_M` and `DISPATCH_MAX_RADIUS_M`** — and the more
   * honest of the two, because the radius only says which circle was offered,
   * while this says which distance a master was willing to travel.
   */
  readonly acceptDistanceM: Distribution;
  /** Offers written across the whole search, all rounds together. */
  readonly offersPerSearch: Distribution;
}

/** One broadcast round, across every search that reached it. */
export interface DispatchRoundMetrics {
  readonly round: number;
  /** Searches that got this far — round 1 is every search that broadcast. */
  readonly searchesReached: number;
  readonly offersSent: number;
  /**
   * Offers written by this round **per search**. **The evidence for
   * `DISPATCH_MAX_MASTERS_PER_BROADCAST`**: if p95 sits well under the cap,
   * the cap is not what is limiting reach and raising it buys nothing.
   */
  readonly mastersPerBroadcast: Distribution;
  /** Searches whose accepted offer was written by this round. */
  readonly acceptsWon: number;
  /** The radius this round broadcast at, in metres. */
  readonly radiusM: Distribution;
}

/** One offer, across every search in the window. */
export interface DispatchOfferMetrics {
  readonly offers: number;
  /** Still `offered` when the report ran — neither acted on nor expired yet. */
  readonly outstanding: number;
  readonly declined: number;
  readonly expired: number;
  readonly accepted: number;
  /** Pre-empted: another master accepted first (ADR-0009, first accept wins). */
  readonly lost: number;
  /**
   * `expired / (expired + declined + accepted)`.
   *
   * `lost` is out of the denominator: those offers were taken off the table by
   * somebody else accepting, so their holder never had a full window to act
   * and counting them would read as indifference. `null` when nothing in the
   * window reached one of the three states.
   *
   * **Evidence for `DISPATCH_RADIUS_STEP_SECONDS`**, which is also how long an
   * offer lives (`offerExpiresAt` in `dispatch-schedule.ts`): a high expiry
   * rate alongside a slow `timeToRespondSeconds` means offers are being
   * withdrawn from masters who were still reading them.
   */
  readonly expiryRate: number | null;
  /** `declined / (expired + declined + accepted)`. */
  readonly declineRate: number | null;
  /**
   * Seconds from an offer being written to the master acting on it — accepts
   * and declines only, because `lost` and `expired` record somebody else's
   * clock rather than this master's decision.
   */
  readonly timeToRespondSeconds: Distribution;
  /** How far every offered master stood, accepted or not, in metres. */
  readonly distanceM: Distribution;
}

export interface DispatchMetricsReport {
  readonly window: DispatchMetricsWindow;
  readonly searches: DispatchSearchMetrics;
  /** Ascending by round. A round nothing reached is absent, not zero-filled. */
  readonly rounds: readonly DispatchRoundMetrics[];
  readonly offers: DispatchOfferMetrics;
}

/**
 * The seven aggregate expressions {@link Distribution} is read from.
 *
 * `expr` must already be `double precision` — `percentile_cont` takes no other
 * numeric type, and casting at the call site keeps the cast next to the column
 * whose type it is compensating for.
 *
 * Nulls are ignored by all seven, which is what lets a caller pass a `CASE`
 * that yields a value only for the rows it wants measured instead of repeating
 * the whole aggregate list behind a `FILTER`.
 */
function distributionOf(expr: SQL): {
  readonly count: SQL;
  readonly mean: SQL;
  readonly p50: SQL;
  readonly p75: SQL;
  readonly p90: SQL;
  readonly p95: SQL;
  readonly max: SQL;
} {
  return {
    count: sql`count(${expr})::int`,
    mean: sql`avg(${expr})::double precision`,
    p50: sql`(percentile_cont(0.5) within group (order by ${expr}))::double precision`,
    p75: sql`(percentile_cont(0.75) within group (order by ${expr}))::double precision`,
    p90: sql`(percentile_cont(0.9) within group (order by ${expr}))::double precision`,
    p95: sql`(percentile_cont(0.95) within group (order by ${expr}))::double precision`,
    max: sql`max(${expr})::double precision`,
  };
}

/** What every distribution-bearing query row carries, under one prefix. */
interface DistributionRow {
  readonly count: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

function toDistribution(row: DistributionRow): Distribution {
  return {
    count: row.count,
    mean: row.mean,
    p50: row.p50,
    p75: row.p75,
    p90: row.p90,
    p95: row.p95,
    max: row.max,
  };
}

/**
 * The CTEs every query below starts from — searches, and the offers belonging
 * to each.
 *
 * **A search is a `SEARCHING` row in `order_status_history` and the transition
 * that follows it.** Nothing else in the schema delimits one: `orders` carries
 * the *current* status and `searching-since.ts` reads only the *latest*
 * `SEARCHING` timestamp, which is right for the engine — a tick only ever acts
 * on the live search — and wrong for a report, which must see the ones that
 * ended. The trail is the only place a finished search is still written down.
 *
 * `windowed` narrows to the orders in scope **before** the window function
 * runs, so `transitions` reads those orders' own trails through
 * `order_status_history_order_idx` rather than sorting the whole table.
 *
 * An offer belongs to the search whose interval contains its `created_at`.
 * That is the only available attribution — `order_offers` carries no search
 * generation — and it is exact, because the engine writes an offer only while
 * the order is `SEARCHING` on that search, under a lock that re-checks both
 * (`order-offers.repository.ts#broadcast`).
 */
function preludeFor(window: DispatchMetricsWindow): SQL {
  return sql`
    with windowed as (
      select distinct order_id
        from order_status_history
       where to_status = 'SEARCHING'
         and created_at >= ${window.from}
         and created_at < ${window.to}
    ),
    transitions as (
      select h.order_id,
             h.to_status,
             h.created_at,
             lead(h.created_at) over w as ended_at,
             lead(h.to_status) over w as ended_status
        from order_status_history h
        join windowed on windowed.order_id = h.order_id
      window w as (partition by h.order_id order by h.created_at, h.id)
    ),
    searches as (
      select order_id, created_at as started_at, ended_at, ended_status
        from transitions
       where to_status = 'SEARCHING'
         and created_at >= ${window.from}
         and created_at < ${window.to}
    ),
    search_offers as (
      select s.order_id,
             s.started_at,
             o.round,
             o.radius_m,
             o.distance_m,
             o.status,
             o.created_at,
             o.responded_at
        from searches s
        join order_offers o
          on o.order_id = s.order_id
         and o.created_at >= s.started_at
         and (s.ended_at is null or o.created_at < s.ended_at)
    ),
    search_offer_totals as (
      select order_id,
             started_at,
             count(*)::int as offers_sent,
             max(round) filter (where status = 'accepted') as accept_round,
             max(radius_m) filter (where status = 'accepted') as accept_radius_m,
             max(distance_m) filter (where status = 'accepted') as accept_distance_m
        from search_offers
       group by order_id, started_at
    )
  `;
}

interface SearchRow extends Record<string, unknown> {
  readonly searches: number;
  readonly accepted: number;
  readonly no_master_found: number;
  readonly cancelled: number;
  readonly other_outcome: number;
  readonly still_open: number;
}

interface RoundRow extends Record<string, unknown> {
  readonly round: number;
  readonly searches_reached: number;
  readonly offers_sent: number;
  readonly accepts_won: number;
}

interface OfferRow extends Record<string, unknown> {
  readonly offers: number;
  readonly outstanding: number;
  readonly declined: number;
  readonly expired: number;
  readonly accepted: number;
  readonly lost: number;
}

/** `a / (a + b)`, or `null` when there is nothing to divide by. */
function shareOf(numerator: number, total: number): number | null {
  return total === 0 ? null : numerator / total;
}

/**
 * Reads `prefix`-named columns off a query row as a {@link Distribution}.
 *
 * The prefixes are literals written in this file, never anything that arrived
 * from outside it — the queries below build fixed column lists, and nothing
 * here interpolates a caller's string into SQL.
 */
function distributionFrom(row: Record<string, unknown>, prefix: string): Distribution {
  const read = (suffix: string): number | null => {
    const value = row[`${prefix}_${suffix}`];
    return typeof value === 'number' ? value : null;
  };

  return toDistribution({
    count: read('count') ?? 0,
    mean: read('mean'),
    p50: read('p50'),
    p75: read('p75'),
    p90: read('p90'),
    p95: read('p95'),
    max: read('max'),
  });
}

/**
 * Everything issue #114 asks to be collected, over one window.
 *
 * Three statements rather than one: they share the prelude but answer
 * questions at three different grains — per search, per round, per offer — and
 * a single query producing all three would either repeat rows or need a
 * grouping set nobody could read back in six months. None is on a request
 * path, so the round trips cost nothing that matters.
 */
export async function collectDispatchMetrics(
  db: DatabaseExecutor,
  window: DispatchMetricsWindow,
): Promise<DispatchMetricsReport> {
  const prelude = preludeFor(window);

  const acceptSeconds = distributionOf(
    sql`(case when f.ended_status = 'ACCEPTED'
              then extract(epoch from (f.ended_at - f.started_at)) end)::double precision`,
  );
  const acceptRound = distributionOf(sql`f.accept_round::double precision`);
  const acceptRadius = distributionOf(sql`f.accept_radius_m::double precision`);
  const acceptDistance = distributionOf(sql`f.accept_distance_m::double precision`);
  const offersPerSearch = distributionOf(sql`f.offers_sent::double precision`);

  const searchResult = await db.execute<SearchRow>(sql`
    ${prelude}
    , search_facts as (
      select s.order_id,
             s.started_at,
             s.ended_at,
             s.ended_status,
             coalesce(t.offers_sent, 0) as offers_sent,
             t.accept_round,
             t.accept_radius_m,
             t.accept_distance_m
        from searches s
        left join search_offer_totals t
          on t.order_id = s.order_id and t.started_at = s.started_at
    )
    select count(*)::int as searches,
           (count(*) filter (where f.ended_status = 'ACCEPTED'))::int as accepted,
           (count(*) filter (where f.ended_status = 'NO_MASTER_FOUND'))::int as no_master_found,
           (count(*) filter (where f.ended_status = 'CANCELLED'))::int as cancelled,
           (count(*) filter (
              where f.ended_status is not null
                and f.ended_status not in ('ACCEPTED', 'NO_MASTER_FOUND', 'CANCELLED')
            ))::int as other_outcome,
           (count(*) filter (where f.ended_status is null))::int as still_open,
           ${acceptSeconds.count} as accept_seconds_count,
           ${acceptSeconds.mean} as accept_seconds_mean,
           ${acceptSeconds.p50} as accept_seconds_p50,
           ${acceptSeconds.p75} as accept_seconds_p75,
           ${acceptSeconds.p90} as accept_seconds_p90,
           ${acceptSeconds.p95} as accept_seconds_p95,
           ${acceptSeconds.max} as accept_seconds_max,
           ${acceptRound.count} as accept_round_count,
           ${acceptRound.mean} as accept_round_mean,
           ${acceptRound.p50} as accept_round_p50,
           ${acceptRound.p75} as accept_round_p75,
           ${acceptRound.p90} as accept_round_p90,
           ${acceptRound.p95} as accept_round_p95,
           ${acceptRound.max} as accept_round_max,
           ${acceptRadius.count} as accept_radius_count,
           ${acceptRadius.mean} as accept_radius_mean,
           ${acceptRadius.p50} as accept_radius_p50,
           ${acceptRadius.p75} as accept_radius_p75,
           ${acceptRadius.p90} as accept_radius_p90,
           ${acceptRadius.p95} as accept_radius_p95,
           ${acceptRadius.max} as accept_radius_max,
           ${acceptDistance.count} as accept_distance_count,
           ${acceptDistance.mean} as accept_distance_mean,
           ${acceptDistance.p50} as accept_distance_p50,
           ${acceptDistance.p75} as accept_distance_p75,
           ${acceptDistance.p90} as accept_distance_p90,
           ${acceptDistance.p95} as accept_distance_p95,
           ${acceptDistance.max} as accept_distance_max,
           ${offersPerSearch.count} as offers_per_search_count,
           ${offersPerSearch.mean} as offers_per_search_mean,
           ${offersPerSearch.p50} as offers_per_search_p50,
           ${offersPerSearch.p75} as offers_per_search_p75,
           ${offersPerSearch.p90} as offers_per_search_p90,
           ${offersPerSearch.p95} as offers_per_search_p95,
           ${offersPerSearch.max} as offers_per_search_max
      from search_facts f
  `);

  const perBroadcast = distributionOf(sql`r.offers::double precision`);
  const roundRadius = distributionOf(sql`r.radius_m::double precision`);

  const roundResult = await db.execute<RoundRow>(sql`
    ${prelude}
    , per_round as (
      select round,
             order_id,
             started_at,
             count(*)::int as offers,
             (count(*) filter (where status = 'accepted'))::int as accepts,
             max(radius_m) as radius_m
        from search_offers
       group by round, order_id, started_at
    )
    select r.round,
           count(*)::int as searches_reached,
           sum(r.offers)::int as offers_sent,
           sum(r.accepts)::int as accepts_won,
           ${perBroadcast.count} as per_broadcast_count,
           ${perBroadcast.mean} as per_broadcast_mean,
           ${perBroadcast.p50} as per_broadcast_p50,
           ${perBroadcast.p75} as per_broadcast_p75,
           ${perBroadcast.p90} as per_broadcast_p90,
           ${perBroadcast.p95} as per_broadcast_p95,
           ${perBroadcast.max} as per_broadcast_max,
           ${roundRadius.count} as radius_count,
           ${roundRadius.mean} as radius_mean,
           ${roundRadius.p50} as radius_p50,
           ${roundRadius.p75} as radius_p75,
           ${roundRadius.p90} as radius_p90,
           ${roundRadius.p95} as radius_p95,
           ${roundRadius.max} as radius_max
      from per_round r
     group by r.round
     order by r.round
  `);

  const respondSeconds = distributionOf(
    sql`(case when o.status in ('declined', 'accepted')
              then extract(epoch from (o.responded_at - o.created_at)) end)::double precision`,
  );
  const offerDistance = distributionOf(sql`o.distance_m::double precision`);

  const offerResult = await db.execute<OfferRow>(sql`
    ${prelude}
    select count(*)::int as offers,
           (count(*) filter (where o.status = 'offered'))::int as outstanding,
           (count(*) filter (where o.status = 'declined'))::int as declined,
           (count(*) filter (where o.status = 'expired'))::int as expired,
           (count(*) filter (where o.status = 'accepted'))::int as accepted,
           (count(*) filter (where o.status = 'lost'))::int as lost,
           ${respondSeconds.count} as respond_seconds_count,
           ${respondSeconds.mean} as respond_seconds_mean,
           ${respondSeconds.p50} as respond_seconds_p50,
           ${respondSeconds.p75} as respond_seconds_p75,
           ${respondSeconds.p90} as respond_seconds_p90,
           ${respondSeconds.p95} as respond_seconds_p95,
           ${respondSeconds.max} as respond_seconds_max,
           ${offerDistance.count} as offer_distance_count,
           ${offerDistance.mean} as offer_distance_mean,
           ${offerDistance.p50} as offer_distance_p50,
           ${offerDistance.p75} as offer_distance_p75,
           ${offerDistance.p90} as offer_distance_p90,
           ${offerDistance.p95} as offer_distance_p95,
           ${offerDistance.max} as offer_distance_max
      from search_offers o
  `);

  const search = searchResult.rows[0];
  const offer = offerResult.rows[0];

  if (search === undefined || offer === undefined) {
    // An aggregate with no GROUP BY always returns exactly one row, so this is
    // unreachable rather than an empty-window case. It is here because the
    // alternative is a non-null assertion, and a wrong assumption about a
    // driver should surface as a message rather than as `undefined` flowing
    // into arithmetic.
    throw new Error('Dispatch metrics query returned no aggregate row');
  }

  const finished = search.accepted + search.no_master_found;
  const actionable = offer.declined + offer.expired + offer.accepted;

  return {
    window,
    searches: {
      searches: search.searches,
      accepted: search.accepted,
      noMasterFound: search.no_master_found,
      cancelled: search.cancelled,
      otherOutcome: search.other_outcome,
      stillOpen: search.still_open,
      noMasterFoundRate: shareOf(search.no_master_found, finished),
      timeToAcceptSeconds: distributionFrom(search, 'accept_seconds'),
      acceptRound: distributionFrom(search, 'accept_round'),
      acceptRadiusM: distributionFrom(search, 'accept_radius'),
      acceptDistanceM: distributionFrom(search, 'accept_distance'),
      offersPerSearch: distributionFrom(search, 'offers_per_search'),
    },
    rounds: roundResult.rows.map((row) => ({
      round: row.round,
      searchesReached: row.searches_reached,
      offersSent: row.offers_sent,
      mastersPerBroadcast: distributionFrom(row, 'per_broadcast'),
      acceptsWon: row.accepts_won,
      radiusM: distributionFrom(row, 'radius'),
    })),
    offers: {
      offers: offer.offers,
      outstanding: offer.outstanding,
      declined: offer.declined,
      expired: offer.expired,
      accepted: offer.accepted,
      lost: offer.lost,
      expiryRate: shareOf(offer.expired, actionable),
      declineRate: shareOf(offer.declined, actionable),
      timeToRespondSeconds: distributionFrom(offer, 'respond_seconds'),
      distanceM: distributionFrom(offer, 'offer_distance'),
    },
  };
}
