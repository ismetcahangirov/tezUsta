import {
  LOCATION_BUDGET,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RATE_LIMIT_BACKOFF_MS,
  STALE_AFTER_FLOORS,
} from './location-budget';
import type { MasterReportingState, ReportingRate } from './location-budget';
import type { LocationPort, Position, WatchSubscription } from './location-port';

/** What the server did with one report. */
export type SendOutcome =
  | 'sent'
  /** `429` — the server's own budget, which must not be answered with a retry. */
  | 'rate-limited'
  /** Anything else: offline, a 409 because the master is no longer online, a 500. */
  | 'failed';

/**
 * What the master can be told about their own reporter.
 *
 * `stale` is the one that matters: Android battery optimisation will kill a
 * background reporter, and a master shown as active while reporting nothing is
 * the failure `master-flow.md` says costs the product a master's trust
 * permanently.
 */
export interface ReporterStatus {
  readonly state: MasterReportingState;
  /** True while the reporter has a live subscription and a running floor. */
  readonly reporting: boolean;
  /** True once {@link STALE_AFTER_FLOORS} floors have passed with nothing sent. */
  readonly stale: boolean;
  /** True when the platform refused, which is a working app with no tracking. */
  readonly blocked: boolean;
}

export interface ReporterOptions {
  readonly location: LocationPort;
  /** Sends one position to `POST /masters/me/location`. Never throws. */
  readonly send: (position: Position) => Promise<SendOutcome>;
  readonly onStatus: (status: ReporterStatus) => void;
  /** Injected so a test can drive time without waiting for it. */
  readonly now?: () => number;
}

export interface LocationReporter {
  /**
   * Retune, or stop. Idempotent for a state it is already in — which matters,
   * because the state arrives from a query that re-renders far more often than
   * it changes, and restarting a GNSS subscription on every render is exactly
   * the battery cost this whole module exists to avoid.
   */
  setState(next: MasterReportingState): Promise<void>;
  /** Stop everything. The reporter can be started again with `setState`. */
  stop(): Promise<void>;
  status(): ReporterStatus;
}

/**
 * The master's position reporter (issue #171).
 *
 * **The floor is a timer and the surplus is a subscription, and they are two
 * mechanisms on purpose.** `expo-location`'s `timeInterval` is Android-only
 * (`Location.types.d.ts`: `@platform android`), so a floor built on it would
 * simply not exist on iOS — and ADR-0026's floor is the thing dispatch's
 * `DISPATCH_MAX_POSITION_AGE_SECONDS` is derived from. A movement-only
 * reporter deletes every parked master from every broadcast, which is the
 * regression this file's first test is named after.
 *
 * **A failed send never becomes a retry.** A `429` is the server stating its
 * own budget and is answered by backing off, doubling to a ceiling above the
 * longest floor; anything else is answered by waiting for the next floor,
 * which is at most two minutes away. Neither case loops.
 *
 * **Nothing here logs a coordinate** (CLAUDE.md §11). The positions this holds
 * reach exactly one place: {@link ReporterOptions.send}.
 */
export function createLocationReporter({
  location,
  send,
  onStatus,
  now = () => Date.now(),
}: ReporterOptions): LocationReporter {
  let state: MasterReportingState = 'offline';
  let rate: ReportingRate | null = null;
  let subscription: WatchSubscription | undefined;
  let floor: ReturnType<typeof setInterval> | undefined;
  let blocked = false;
  let stale = false;
  let lastSentAt: number | null = null;
  let backoffUntil = 0;
  let backoffMs = RATE_LIMIT_BACKOFF_MS;
  /** The newest point the subscription produced, so a floor need not ask again. */
  let newest: Position | undefined;

  function status(): ReporterStatus {
    return { state, reporting: floor !== undefined, stale, blocked };
  }

  function publish(): void {
    onStatus(status());
  }

  function markStale(next: boolean): void {
    if (stale !== next) {
      stale = next;
      publish();
    }
  }

  /**
   * One report, wherever the position came from.
   *
   * **The backoff is checked here rather than around the floor**, so a
   * movement report cannot slip past a rate limit the floor is respecting —
   * the server counts them the same.
   */
  async function report(position: Position): Promise<void> {
    if (now() < backoffUntil) {
      return;
    }

    const outcome = await send(position);

    if (outcome === 'sent') {
      lastSentAt = now();
      backoffMs = RATE_LIMIT_BACKOFF_MS;
      markStale(false);
      return;
    }

    if (outcome === 'rate-limited') {
      backoffUntil = now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, RATE_LIMIT_BACKOFF_MAX_MS);
    }
  }

  /**
   * The position a floor tick sends.
   *
   * In order of cost: the newest point the subscription already produced, then
   * the platform's last known fix, then — only where the budget says this
   * state is worth one — a fresh fix. A parked master's floor therefore costs
   * a request and no radio.
   */
  async function positionForFloor(current: ReportingRate): Promise<Position | null> {
    if (newest !== undefined) {
      return newest;
    }

    const known = await location.lastKnown();
    if (known !== null) {
      return known;
    }

    return current.needsFreshFix ? location.current() : null;
  }

  function isOverdue(current: ReportingRate): boolean {
    if (lastSentAt === null) {
      return false;
    }
    return now() - lastSentAt > current.floorSeconds * STALE_AFTER_FLOORS * 1_000;
  }

  async function tick(current: ReportingRate): Promise<void> {
    const position = await positionForFloor(current);

    if (position !== null) {
      await report(position);
    }

    markStale(isOverdue(current));
  }

  function clear(): void {
    subscription?.remove();
    subscription = undefined;
    if (floor !== undefined) {
      clearInterval(floor);
      floor = undefined;
    }
    newest = undefined;
  }

  async function start(current: ReportingRate): Promise<void> {
    try {
      subscription = await location.watch(
        { distanceMeters: current.distanceMeters, needsFreshFix: current.needsFreshFix },
        (position) => {
          newest = position;
          void report(position);
        },
      );
      blocked = false;
    } catch {
      /**
       * **Denial degrades; it does not break.** The platform refused, so there
       * is no surplus and no floor — but the order, the offers and every other
       * screen still work, and the master is told what tracking costs them
       * rather than shown an error they cannot act on. Deliberately silent:
       * the rejection can carry a coordinate.
       */
      blocked = true;
      publish();
      return;
    }

    // The first report goes out at once rather than one floor later. A master
    // who has just gone online expects to be offered work now, and dispatch
    // cannot see them until a position exists.
    void tick(current);

    floor = setInterval(() => {
      void tick(current);
    }, current.floorSeconds * 1_000);

    publish();
  }

  return {
    async setState(next) {
      if (next === state) {
        return;
      }

      state = next;
      rate = LOCATION_BUDGET[next];
      clear();
      lastSentAt = null;
      markStale(false);

      if (rate === null) {
        blocked = false;
        publish();
        return;
      }

      await start(rate);
    },

    async stop() {
      clear();
      state = 'offline';
      rate = null;
      blocked = false;
      lastSentAt = null;
      markStale(false);
      publish();
      return Promise.resolve();
    },

    status,
  };
}
