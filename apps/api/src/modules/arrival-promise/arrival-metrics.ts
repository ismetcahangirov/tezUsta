import { sql } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../infra/database/database.types';
import { ESTIMATE_DETOUR_FACTOR, ESTIMATE_SPEED_KMH } from '../../infra/geo/driving-estimate';
import type { Distribution, DispatchMetricsWindow } from '../dispatch/dispatch-metrics';
import { distributionFrom, distributionOf, shareOf } from '../dispatch/dispatch-metrics';

/**
 * Trips shorter than this are left out of the calibration: over a few hundred
 * metres the time to walk to the car and park outweighs the drive, and the
 * seconds-per-metre ratio would be noise.
 */
export const CALIBRATION_MIN_DISTANCE_M = 500;

/** The current estimate's cost of one straight-line metre, in seconds (ADR-0055 § 10). */
export const CURRENT_SECONDS_PER_METRE =
  ESTIMATE_DETOUR_FACTOR / ((ESTIMATE_SPEED_KMH * 1000) / 3600);

/** How one source of promise was kept. */
export interface PromiseKeeping {
  /** Promises of this source whose master has arrived: what the rest is measured over. */
  readonly measured: number;
  readonly onTime: number;
  /** `onTime / measured`. */
  readonly onTimeShare: number | null;
  /** Arrival minus promise, seconds; negative is early. */
  readonly lateBySeconds: Distribution;
}

/**
 * The data ADR-0055 § 10 says will replace the fallback's two guesses: how
 * long a real trip takes per metre of the straight-line distance the master
 * was offered at.
 */
export interface EstimateCalibration {
  /** Arrived trips of at least {@link CALIBRATION_MIN_DISTANCE_M}. */
  readonly trips: number;
  /** `(arrived − accepted) / distance_m`, seconds per straight-line metre. */
  readonly secondsPerMetre: Distribution;
  /** What the current estimate charges per metre: 1.4 at 20 km/h. */
  readonly currentSecondsPerMetre: number;
  /** Share of the trips the current estimate would have allowed enough time for. */
  readonly currentCoverage: number | null;
  /**
   * The speed, at the current detour factor, at which the estimate would
   * cover 75 % and 90 % of the trips. Null without data.
   */
  readonly speedKmhCovering75: number | null;
  readonly speedKmhCovering90: number | null;
}

export interface ArrivalMetricsReport {
  readonly window: DispatchMetricsWindow;
  /** Orders whose current assignment was accepted in the window. */
  readonly accepts: number;
  readonly promised: number;
  readonly promisedByRoute: number;
  readonly promisedByEstimate: number;
  /** Accepts whose current master has reached `MASTER_ARRIVED`. */
  readonly arrived: number;
  readonly overall: PromiseKeeping;
  readonly route: PromiseKeeping;
  readonly estimate: PromiseKeeping;
  readonly calibration: EstimateCalibration;
}

type Row = Record<string, unknown>;

function int(row: Row, column: string): number {
  const value = row[column];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** The speed that makes `ESTIMATE_DETOUR_FACTOR × d / v` equal `secondsPerMetre × d`. */
function speedKmhFor(secondsPerMetre: number | null): number | null {
  if (secondsPerMetre === null || secondsPerMetre <= 0) {
    return null;
  }
  return (ESTIMATE_DETOUR_FACTOR / secondsPerMetre) * 3.6;
}

/**
 * How the arrival promises of one window were kept, and what real trips say
 * about the fallback estimate (issue #410, ADR-0055 § 10–11).
 *
 * **The current assignment of each order**, as the admin's lateness is: the
 * master on `orders.master_id` now, accepted at `orders.accepted_at`, arrived
 * at the first `MASTER_ARRIVED` at or after that accept. A re-dispatched
 * order's earlier master is not counted, because nothing kept their promise
 * (ADR-0055 _Trade-offs_).
 *
 * **No route and no coordinate is read.** The distance is the one the master
 * was offered at (`order_offers.distance_m`), which is ours; route durations
 * are not stored (§ 7). The travel time starts at the accept, as the promise
 * does, so a master who leaves late reads as a slow trip — which is what the
 * estimate has to cover.
 *
 * One statement, read-only. It scans the window's orders by `accepted_at`,
 * which no index serves; it runs by hand from a CLI, never on a request path.
 */
export async function collectArrivalMetrics(
  db: DatabaseExecutor,
  window: DispatchMetricsWindow,
): Promise<ArrivalMetricsReport> {
  const late = distributionOf(sql`f.late_s`);
  const lateRoute = distributionOf(sql`(case when f.source = 'route' then f.late_s end)`);
  const lateEstimate = distributionOf(sql`(case when f.source = 'estimate' then f.late_s end)`);
  const perMetre = distributionOf(sql`f.seconds_per_metre`);

  const columns = (prefix: string, d: ReturnType<typeof distributionOf>) => sql`
    ${d.count} as ${sql.raw(`${prefix}_count`)},
    ${d.mean} as ${sql.raw(`${prefix}_mean`)},
    ${d.p50} as ${sql.raw(`${prefix}_p50`)},
    ${d.p75} as ${sql.raw(`${prefix}_p75`)},
    ${d.p90} as ${sql.raw(`${prefix}_p90`)},
    ${d.p95} as ${sql.raw(`${prefix}_p95`)},
    ${d.max} as ${sql.raw(`${prefix}_max`)}`;

  const result = await db.execute<Row>(sql`
    with current_accepts as (
      select o.id,
             o.accepted_at,
             o.promised_arrival_at,
             o.arrival_promise_source::text as source,
             oo.distance_m,
             (select min(h.created_at)
                from order_status_history h
               where h.order_id = o.id
                 and h.to_status = 'MASTER_ARRIVED'
                 and h.created_at >= o.accepted_at) as arrived_at
        from orders o
        left join order_offers oo
          on oo.order_id = o.id and oo.master_id = o.master_id and oo.status = 'accepted'
       where o.accepted_at >= ${window.from}::timestamptz
         and o.accepted_at < ${window.to}::timestamptz
    ),
    facts as (
      select a.*,
             (case when a.arrived_at is not null and a.promised_arrival_at is not null
                   then extract(epoch from (a.arrived_at - a.promised_arrival_at)) end
             )::double precision as late_s,
             (case when a.arrived_at is not null and a.distance_m >= ${CALIBRATION_MIN_DISTANCE_M}
                   then extract(epoch from (a.arrived_at - a.accepted_at)) / a.distance_m end
             )::double precision as seconds_per_metre
        from current_accepts a
    )
    select count(*)::int as accepts,
           (count(*) filter (where f.promised_arrival_at is not null))::int as promised,
           (count(*) filter (where f.source = 'route'))::int as promised_route,
           (count(*) filter (where f.source = 'estimate'))::int as promised_estimate,
           (count(*) filter (where f.arrived_at is not null))::int as arrived,
           (count(*) filter (where f.late_s <= 0))::int as on_time,
           (count(*) filter (where f.late_s <= 0 and f.source = 'route'))::int as on_time_route,
           (count(*) filter (where f.late_s <= 0 and f.source = 'estimate'))::int as on_time_estimate,
           (count(*) filter (
              where f.seconds_per_metre <= ${CURRENT_SECONDS_PER_METRE}::double precision
            ))::int as covered,
           ${columns('late', late)},
           ${columns('late_route', lateRoute)},
           ${columns('late_estimate', lateEstimate)},
           ${columns('per_metre', perMetre)}
      from facts f
  `);

  const row: Row = result.rows[0] ?? {};
  const keeping = (prefix: string, onTimeColumn: string): PromiseKeeping => {
    const lateBySeconds = distributionFrom(row, prefix);
    const onTime = int(row, onTimeColumn);
    return {
      measured: lateBySeconds.count,
      onTime,
      onTimeShare: shareOf(onTime, lateBySeconds.count),
      lateBySeconds,
    };
  };
  const secondsPerMetre = distributionFrom(row, 'per_metre');

  return {
    window,
    accepts: int(row, 'accepts'),
    promised: int(row, 'promised'),
    promisedByRoute: int(row, 'promised_route'),
    promisedByEstimate: int(row, 'promised_estimate'),
    arrived: int(row, 'arrived'),
    overall: keeping('late', 'on_time'),
    route: keeping('late_route', 'on_time_route'),
    estimate: keeping('late_estimate', 'on_time_estimate'),
    calibration: {
      trips: secondsPerMetre.count,
      secondsPerMetre,
      currentSecondsPerMetre: CURRENT_SECONDS_PER_METRE,
      currentCoverage: shareOf(int(row, 'covered'), secondsPerMetre.count),
      speedKmhCovering75: speedKmhFor(secondsPerMetre.p75),
      speedKmhCovering90: speedKmhFor(secondsPerMetre.p90),
    },
  };
}
