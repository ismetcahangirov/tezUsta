/**
 * The master's reporting budget, as one object (issue #171).
 *
 * **Every number the reporter uses is here and nowhere else**, because #173
 * exists to replace them with measured ones and a constant scattered across
 * three files is a constant that gets revised in two of them. The table is
 * `docs/architecture/realtime-architecture.md` § Location update budget,
 * transcribed — that document is the authority and this is its executable
 * copy.
 *
 * **The interval is a floor, not a ceiling, and that is the load-bearing
 * sentence** ([ADR-0026](docs/decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
 * While online, a report goes out every interval whether or not the phone
 * moved a metre. Dispatch excludes a master whose newest position is older
 * than `DISPATCH_MAX_POSITION_AGE_SECONDS`, and that bound is *derived* from
 * this floor — so a movement-only reporter deletes every parked master from
 * every broadcast. It is not a compliant implementation of this budget, and
 * the test named after that regression is what keeps it from becoming one.
 *
 * The distance filter governs only the reports *between* floors, through
 * `expo-location`'s `distanceInterval`, which the platform applies without
 * waking the JS thread.
 */

/**
 * What the master is doing, as far as the app can tell.
 *
 * **Only two of these can be reached today, and that is a gap in the app
 * rather than in this table.** `travelling` and `working` describe a master
 * with an assigned order, and this app has no surface that knows about one:
 * there is no job list and no "my current order" read, so nothing can select
 * those rows (issue #171 assumes an order surface that EPIC 8/9 has not built
 * yet). They are declared and implemented here, with their own tests, so that
 * the day a job screen lands the wiring is a call to {@link
 * LocationReporter.setState} rather than a design.
 */
export type MasterReportingState =
  /** Not available. Nothing is reported, and nothing is collected. */
  | 'offline'
  /** Available and waiting for work. */
  | 'online'
  /** Assigned an order and on the way — the customer is watching the marker. */
  | 'travelling'
  /** Arrived, or working. The marker has stopped being interesting. */
  | 'working';

/** What one state costs. `null` means this state reports nothing at all. */
export interface ReportingRate {
  /**
   * The floor, in seconds. A report goes out this often whether or not the
   * phone moved.
   */
  readonly floorSeconds: number;
  /**
   * How far the phone must move to earn an **extra** report between floors, in
   * metres. `null` disables the surplus entirely — the floor is the whole
   * budget.
   */
  readonly distanceMeters: number | null;
  /**
   * Whether this state is worth a GNSS fix.
   *
   * **The floor should cost the cheapest fix that is still true.** For an idle
   * master the last known position is enough, and the expensive part of a
   * report on a mid-range Android is the fix, not the request. Accuracy
   * matters while travelling, where a customer is watching the marker move.
   */
  readonly needsFreshFix: boolean;
}

export const LOCATION_BUDGET: Readonly<Record<MasterReportingState, ReportingRate | null>> =
  Object.freeze({
    offline: null,

    /**
     * 90 s is the middle of the document's 60–120 s band. Picking the middle
     * rather than either end is deliberate: both are hypotheses until #173
     * measures a real shift, and the middle is the value that is least wrong
     * if the true answer is at either end.
     */
    online: { floorSeconds: 90, distanceMeters: 100, needsFreshFix: false },

    /**
     * 12 s, the middle of 10–15 s, and the one row where the floor is short
     * enough to matter to a person: this is what
     * `DISPATCH_MAX_POSITION_AGE_SECONDS` is derived from and what the
     * customer's marker advances on.
     */
    travelling: { floorSeconds: 12, distanceMeters: 25, needsFreshFix: true },

    /**
     * The document offers "120 s or none". 120 s rather than none, because a
     * master who is working is still *reachable*, and a report is also the
     * presence heartbeat (`master-location.service.ts`) — reporting nothing
     * would make a working master look offline to dispatch the moment the
     * presence key expired.
     */
    working: { floorSeconds: 120, distanceMeters: null, needsFreshFix: false },
  });

/**
 * How many missed floors it takes to call the reporter stale.
 *
 * **Android battery optimisation will kill the reporter**, and a master shown
 * as active while reporting nothing is the failure this guards. Three floors
 * rather than one: a single missed interval is a phone that was busy, and
 * telling a master something is wrong every time their handset stutters is how
 * a warning stops being read.
 */
export const STALE_AFTER_FLOORS = 3;

/**
 * The first backoff after the server says `429`, and the ceiling it doubles
 * to.
 *
 * `MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR` is the server's authority over
 * how often a master may report, and a client that answered it with an
 * immediate retry would burn the rest of the hour's budget in a loop — which
 * ends with a master invisible to dispatch for the rest of their shift. The
 * ceiling is above the longest floor in the table, so a backed-off reporter
 * has genuinely stopped rather than merely slowed.
 */
export const RATE_LIMIT_BACKOFF_MS = 60_000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 600_000;
