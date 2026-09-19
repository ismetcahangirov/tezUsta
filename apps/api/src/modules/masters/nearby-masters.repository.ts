import { Inject, Injectable } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';

/**
 * One master dispatch may broadcast to, before Redis has had its say.
 *
 * `distanceM` is true great-circle metres — the `::geography` cast, never
 * degrees — and is the only ordering this query applies (ADR-0009: the
 * weighted model on rating and response rate is explicitly out of scope until
 * there is data to tune it against).
 */
export interface NearbyMasterCandidate {
  readonly masterId: string;
  readonly distanceM: number;
  /**
   * This master's own price for this service, in minor units, or null for an
   * inspection-priced service where the amount does not exist until somebody
   * has seen the work.
   *
   * It travels with the candidate because the accept path freezes it
   * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)) and the offer
   * card shows it — fetching it again per master afterwards would be a second
   * query per broadcast and a chance for the two reads to disagree.
   *
   * **This value is read at broadcast time, and the accept path must not
   * freeze it.** It is what the offer card shows; it is not what the order is
   * billed at. A master may edit their price between the broadcast and the
   * accept, and ADR-0013 freezes the price *in the accept transaction, from
   * the accepting master's stored price* — so `orders.price_minor` is written
   * from a re-read inside the same conditional `UPDATE` that assigns the
   * master, never from a number carried since the broadcast. Carrying it would
   * let a stale offer card set the price of a real order, which is the
   * creation-time freeze ADR-0013 exists to supersede.
   */
  readonly priceMinor: number | null;
}

/**
 * How many candidates Postgres is asked for, per master dispatch may broadcast
 * to.
 *
 * **The liveness filter runs after the `LIMIT`, so a dark master inside the
 * nearest N consumes a slot in the broadcast.** Fetching exactly the cap means
 * that if the twenty nearest candidates have all gone dark, the broadcast is
 * empty while live masters sit just outside — and widening the radius cannot
 * rescue it, because the next round returns the same dark ids plus farther
 * masters that sort after them and are cut by the same `LIMIT`.
 *
 * Three, because a candidate is already a master who is available *and*
 * reported a position inside `DISPATCH_MAX_POSITION_AGE_SECONDS`: to be dark
 * as well, their app has to have died inside that window, which is a small
 * fraction of any healthy fleet. Three tolerates two thirds of the nearest
 * candidates being dark before the broadcast shrinks at all. The cost is
 * bounded and paid in the only three places this widens — the Postgres
 * top-N sort, the rows crossing the wire, and the keys in one `MGET` — all of
 * which are `DISPATCH_MAX_MASTERS_PER_BROADCAST * 3` rather than the whole
 * fleet. Raising it further buys resilience against a failure mode (most of a
 * city's phones dark at once) that a wider `LIMIT` is not the right answer to.
 */
export const CANDIDATE_OVERFETCH_FACTOR = 3;

/** Where dispatch is looking, and for what. */
export interface NearbyMastersQuery {
  readonly serviceId: string;
  readonly latitude: number;
  readonly longitude: number;
  /** The current round's radius — it widens between rounds (ADR-0009). */
  readonly radiusM: number;
}

interface NearbyMastersQueryParameters extends NearbyMastersQuery {
  readonly maxCommissionDebtMinor: number;
  /**
   * How old the newest position may be before the master counts as missing —
   * `DISPATCH_MAX_POSITION_AGE_SECONDS`, never the presence TTL (ADR-0026).
   */
  readonly maxPositionAgeSeconds: number;
  readonly limit: number;
}

/**
 * The parameterised SQL behind {@link NearbyMastersRepository.findCandidates},
 * exported so a test can wrap it in `EXPLAIN` **and be sure it is explaining
 * the query that actually runs**.
 *
 * A plan assertion against a hand-copied query proves nothing about the
 * shipped one — the two drift apart on the first edit, and the symptom is a
 * sequential scan in production with a green test suite (ADR-0018 measured
 * 824 ms against 2.0 ms for exactly that mistake).
 *
 * ## Why it is not the query `database-architecture.md` first sketched
 *
 * That sketch drives from `masters`, joins `master_services`, takes each
 * candidate's latest position through a `LATERAL`, and applies `ST_DWithin`
 * to the result. It is correct, and its plan is a nested loop over **every
 * master who offers the service** — the GiST index on `(position::geography)`
 * is unreachable from inside a lateral that is already keyed by `master_id`.
 * The cost scales with the size of the trade, not with how many masters are
 * nearby, which is the shape CLAUDE.md §12 exists to prevent.
 *
 * So the query is driven from the spatial index instead, in two steps:
 *
 * 1. `recent_in_range` asks the index the question it is built to answer —
 *    which masters reported *any* position inside the radius within the
 *    freshness window. That is a superset, and it is a `Bitmap Index Scan` on
 *    `master_locations_position_idx`.
 * 2. The `LATERAL` then takes each of those masters' **latest** position and
 *    re-checks the radius against it, which is what makes the answer exact: a
 *    master whose newest report is outside the radius is excluded even though
 *    a report from forty seconds ago was inside it.
 *
 * Both steps carry the same freshness cutoff, and the second one is an inner
 * join, so a master with no position inside the window disappears rather than
 * being ranked on a stale one.
 *
 * ## Every term, and where it is evaluated
 *
 * Postgres owns verification, intent, the service offer, the radius and the
 * debt gate. **Liveness is not here** — it is a Redis TTL, it belongs to
 * `MasterPresenceService`, and `NearbyMastersService` is where the two stages
 * meet. Shipping either stage alone is not correct
 * (`docs/architecture/database-architecture.md` § The nearby-masters query).
 *
 * Every value is a bound parameter. Nothing is interpolated into SQL text
 * (CLAUDE.md §11).
 */
export function nearbyMastersQuery(parameters: NearbyMastersQueryParameters): SQL {
  const {
    serviceId,
    latitude,
    longitude,
    radiusM,
    maxCommissionDebtMinor,
    maxPositionAgeSeconds,
    limit,
  } = parameters;

  // Longitude first — `ST_MakePoint` takes x then y, and x is longitude. A
  // swap passes every bound check in Baku, which is why the fixtures place
  // masters with `ST_Project` rather than by adding degrees.
  const searchPoint = sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;

  // Server time on both sides of the comparison, evaluated by the database.
  // `now()` is fixed for the statement, so the two references below cannot
  // disagree with each other.
  const freshSince = sql`(now() - make_interval(secs => ${maxPositionAgeSeconds}::int))`;

  return sql`
    with recent_in_range as (
      select distinct ml.master_id
        from master_locations ml
       where ml.recorded_at > ${freshSince}
         and ST_DWithin(ml.position::geography, ${searchPoint}, ${radiusM})
    )
    select m.id::text as master_id,
           ST_Distance(latest.position::geography, ${searchPoint}) as distance_m,
           ms.price_minor::int as price_minor
      from recent_in_range r
      join masters m
        on m.id = r.master_id
       and m.deleted_at is null
       and m.verification_status = 'active'
       and m.is_available
       and m.commission_debt_minor <= ${maxCommissionDebtMinor}
      join master_services ms
        on ms.master_id = m.id
       and ms.service_id = ${serviceId}
       and ms.is_active
      join lateral (
        select ml.position
          from master_locations ml
         where ml.master_id = m.id
           and ml.recorded_at > ${freshSince}
         -- recorded_at defaults to now(), which is transaction time, so two
         -- rows written in one transaction carry the same timestamp and "the
         -- latest" would be whichever the plan happened to reach first. The id
         -- tiebreaker makes the answer the same on every run.
         order by ml.recorded_at desc, ml.id desc
         limit 1
      ) latest on ST_DWithin(latest.position::geography, ${searchPoint}, ${radiusM})
     order by distance_m asc
     limit ${limit}
  `;
}

/**
 * The raw row shape, in the database's own `snake_case`.
 *
 * A `type` rather than an `interface`, because `db.execute<T>` constrains `T`
 * to `Record<string, unknown>` and only a type alias to an object literal gets
 * the implicit index signature that satisfies it.
 */
type NearbyMasterRow = {
  readonly master_id: string;
  readonly distance_m: number;
  readonly price_minor: number | null;
};

/**
 * The Postgres half of the nearby-eligible-masters query (issue #100).
 *
 * Drizzle queries only, no business rules and no HTTP
 * (`docs/architecture/backend-architecture.md` § Module rules) — which is also
 * why Redis is not touched here. `NearbyMastersService` composes this with
 * presence; this file is what Postgres can answer on its own.
 *
 * **It is not, and must not become, an endpoint.** Dispatch calls it. A "find
 * masters near me" route over the same query would hand every master's
 * position to anyone who asked, which is the disclosure
 * `docs/engineering/security.md` treats location as PII to prevent.
 */
@Injectable()
export class NearbyMastersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Masters this order could be broadcast to, nearest first, as far as
   * Postgres can tell.
   *
   * **Every bound is enforced here, whether it comes from configuration or
   * from the caller.** The radius is the one value dispatch chooses per round
   * (ADR-0009 widens it), and it is checked rather than trusted — see
   * {@link clampRadius}. The rest are read from configuration, in one place:
   *
   * - `DISPATCH_MAX_MASTERS_PER_BROADCAST` caps what dispatch broadcasts. This
   *   query asks Postgres for {@link CANDIDATE_OVERFETCH_FACTOR} times that
   *   many, because the presence stage above still has to remove masters who
   *   have gone dark and `NearbyMastersService` truncates to the real cap
   *   afterwards.
   * - `MAX_COMMISSION_DEBT_MINOR` is the cash-order brake (ADR-0007,
   *   `docs/product/master-flow.md` § Accepting). The column reads zero until
   *   EPIC 12 populates it, and the term ships now so the predicate is never
   *   edited a second time.
   * - `DISPATCH_MAX_POSITION_AGE_SECONDS` bounds the age of the newest
   *   position. A master whose last report predates it is **missing**, not "in
   *   range at their last known point".
   *
   *   **It is deliberately not `PRESENCE_TTL_SECONDS`**
   *   ([ADR-0026](docs/decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
   *   A position report refreshes presence, but a heartbeat does not write a
   *   position, so the two windows come apart for every master who is online
   *   and stationary — and bounding this one by the presence TTL dropped a
   *   parked, heartbeating, perfectly available master out of every broadcast.
   *   What this bound protects against is a position left over from a previous
   *   session; what makes a stationary master's last position still true is
   *   the reporting floor the location budget now guarantees.
   *
   * Nothing here logs a coordinate, at any level (CLAUDE.md §11).
   */
  async findCandidates(query: NearbyMastersQuery): Promise<NearbyMasterCandidate[]> {
    const result = await this.db.execute<NearbyMasterRow>(
      nearbyMastersQuery({
        ...query,
        radiusM: this.clampRadius(query.radiusM),
        maxCommissionDebtMinor: this.config.orders.maxCommissionDebtMinor,
        maxPositionAgeSeconds: this.config.dispatch.maxPositionAgeSeconds,
        limit: this.config.dispatch.maxMastersPerBroadcast * CANDIDATE_OVERFETCH_FACTOR,
      }),
    );

    return result.rows.map((row) => ({
      masterId: row.master_id,
      distanceM: Number(row.distance_m),
      priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    }));
  }

  /**
   * The caller's radius, brought inside `DISPATCH_MAX_RADIUS_M`.
   *
   * The radius is the one parameter dispatch owns — rounds widen it (ADR-0009)
   * — and an unbounded one is not merely a wide search: `ST_DWithin` over a
   * radius covering the country turns the GiST prefilter into a scan of the
   * whole trail table, which is the failure CLAUDE.md §12 exists to prevent.
   * `DISPATCH_MAX_RADIUS_M` is where dispatch stops widening, so it is also
   * the largest radius this query will answer.
   *
   * Over the ceiling is **clamped**, because asking too widely is a policy
   * question with a documented answer. Zero, negative, or not a number is
   * **thrown**, because it is a defect in the caller and the quiet alternative
   * — an empty result — reaches the customer as `NO_MASTER_FOUND` with nothing
   * anywhere saying why.
   */
  private clampRadius(radiusM: number): number {
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      throw new RangeError(
        `A dispatch radius must be a positive number of metres, got ${String(radiusM)}`,
      );
    }
    return Math.min(radiusM, this.config.dispatch.maxRadiusM);
  }
}
