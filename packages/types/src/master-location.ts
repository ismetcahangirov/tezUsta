import type { MasterAvailability } from './master.js';

/**
 * One position report from a master's app.
 *
 * Two plain numbers in WGS 84 degrees, and nothing else. No timestamp: the
 * server stamps `recordedAt` itself, because a device clock is settable and
 * frequently wrong, and a trail ordered by a value the reporter chooses puts
 * whichever handset is most confidently mistaken at the top. No accuracy,
 * speed or heading either — nothing reads them yet, and a field that is
 * collected before it is used is personal data held for no reason.
 */
export interface MasterLocationReport {
  /** Degrees, -90..90. */
  readonly latitude: number;

  /** Degrees, -180..180. */
  readonly longitude: number;
}

/**
 * What the server says back when it has written a position down.
 *
 * **It carries the whole presence state**, because reporting a position *is*
 * the heartbeat: a master whose app is sending coordinates is by definition
 * reachable, and charging a mid-range Android a second HTTP round trip to say
 * so again is a battery cost with no information in it
 * (`docs/architecture/realtime-architecture.md` § Location update budget,
 * which aligns the heartbeat interval with the reporting interval for exactly
 * this reason). A client that reports location therefore does not need to beat
 * as well, and `presence.heartbeatSeconds` is how often the server wants to
 * hear from it either way.
 *
 * **No coordinate comes back.** The app knows where it is; echoing the
 * position would put it in one more log, proxy and crash report for nothing.
 */
export interface MasterLocationReceipt {
  /**
   * When the **server** recorded the position, ISO 8601 UTC. Lets the app show
   * "reported 8 seconds ago" against a clock both sides agree on, and tell a
   * master their reporting has gone stale rather than silently showing them as
   * active.
   */
  readonly recordedAt: string;

  /** Liveness and stored intent, exactly as the availability endpoints report them. */
  readonly presence: MasterAvailability;
}
