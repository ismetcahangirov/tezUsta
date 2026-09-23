import type { OrderStatus } from '@tezusta/types';

import { LOCATION_BUDGET } from '../location/location-budget';
import type { ConnectionStatus } from '../realtime/connection-slice';
import type { MapPoint } from './map-surface.types';

/**
 * Every number and rule the customer's tracking map runs on, in one file
 * ([ADR-0035](../../../../docs/decisions/ADR-0035-customer-tracking-map.md),
 * issue #172).
 *
 * Kept apart from the component for the reason `location-budget.ts` is kept
 * apart from the reporter: #173 exists to replace these hypotheses with
 * measured values, and a number that lives in a render function is a number
 * that gets revised in one place and not the other.
 */

/**
 * The server's `REALTIME_POSITION_FANOUT_SECONDS` default
 * (`apps/api/src/infra/config/env.schema.ts`), transcribed.
 *
 * **A copy, and deliberately so.** The value is server configuration, not an
 * API contract, so there is nothing for the app to import it from — and a
 * `GET /config` for one number would be a request on the hottest screen in the
 * app. If an operator changes the server's value, the freshness window below
 * is what drifts, and it drifts in the safe direction for a smaller fan-out
 * interval (a point is called stale later than it could be, never earlier than
 * it should be) and must be revisited for a larger one.
 */
export const SERVER_POSITION_FANOUT_SECONDS = 15;

/**
 * How long a received position may still be drawn as live.
 *
 * **Derived, not chosen.** The fan-out throttle is leading-edge
 * (`realtime-architecture.md` § The server → customer throttle): the report
 * that opens a window is broadcast, and the next broadcast is the first report
 * *after* the window closes. A compliant travelling master reports on a floor
 * (`LOCATION_BUDGET.travelling`, 12 s), so the worst gap between two broadcasts
 * a customer can see from a healthy master is one window plus one floor —
 * 15 + 12 = 27 s. One more floor on top absorbs a single late report or a slow
 * network hop without calling a healthy master stale, and stops short of the
 * reporter's own "three missed floors" staleness (`STALE_AFTER_FLOORS`): 39 s.
 *
 * Anything older than that is not a moving master the customer should watch
 * glide; it is a last known position, and the screen says so.
 */
export const POSITION_FRESHNESS_MS =
  (SERVER_POSITION_FANOUT_SECONDS + 2 * (LOCATION_BUDGET.travelling?.floorSeconds ?? 0)) * 1000;

/**
 * How long the marker takes to travel from where it is drawn to a new point.
 *
 * **One fan-out window**, so that a master whose points arrive on schedule is
 * drawn moving continuously rather than hopping every fifteen seconds and
 * standing still in between. It is always shorter than
 * {@link POSITION_FRESHNESS_MS}, which is what guarantees a glide has finished
 * before its point could turn stale — the marker never animates towards a
 * position the screen is simultaneously calling old.
 */
export const MARKER_GLIDE_MS = SERVER_POSITION_FANOUT_SECONDS * 1000;

/**
 * How often the gliding marker is redrawn.
 *
 * **Four times a second, not sixty.** At the zoom a street map is shown at, a
 * car covers a metre or two in 250 ms — below a pixel — so a faster tick buys
 * nothing a person can see and costs a JS-thread render every frame on the
 * mid-range Android this app is built for (CLAUDE.md §12). The native marker
 * animation would have been cheaper still, and `react-native-maps@1.27.2` does
 * not implement it for Google Maps on iOS (ADR-0035).
 */
export const MARKER_TICK_MS = 250;

/**
 * Whether the map is shown at all, per status.
 *
 * **Accepted and on the way, and nothing else.** Those are the two statuses in
 * which a customer is waiting for somebody to *arrive*, and the only two in
 * which the master reports on the travelling floor.
 *
 * - Before an accept there is no master, and the server sends no position.
 * - `MASTER_ARRIVED` and `IN_PROGRESS` still carry a position on the wire
 *   (the server fans out for all four engaged statuses), but the master is at
 *   the door: the question the map answers has been answered, and the working
 *   floor is 120 s, so the map would spend the whole job saying "stale".
 *   Showing somebody's position when nobody needs it is also the thing
 *   CLAUDE.md §11 asks us not to do with PII.
 * - Every terminal status hides it, so after the order ends nothing is drawn
 *   even if a late frame were still in the cache.
 *
 * Total over {@link OrderStatus}, the way `order-status-presentation.ts` is: a
 * status added to ADR-0015 without a decision here does not compile.
 */
const TRACKED_BY_STATUS: Readonly<Record<OrderStatus, boolean>> = {
  DRAFT: false,
  SEARCHING: false,
  ACCEPTED: true,
  MASTER_ON_THE_WAY: true,
  MASTER_ARRIVED: false,
  IN_PROGRESS: false,
  COMPLETED: false,
  PAYMENT_PENDING: false,
  PAID: false,
  DISPUTED: false,
  RESOLVED: false,
  REFUNDED: false,
  NO_MASTER_FOUND: false,
  CANCELLED: false,
};

export function isTrackedStatus(status: OrderStatus): boolean {
  return TRACKED_BY_STATUS[status];
}

/**
 * What the tracking surface can honestly say, as one value.
 *
 * - `hidden` — the order is not in a status where a position means anything.
 * - `absent` — it is, and no position has arrived. Not an error: the master
 *   may have denied location, their reporter may have been killed, or the
 *   socket may never have come up. The rest of the screen works regardless.
 * - `live` — a point arrived within {@link POSITION_FRESHNESS_MS} over a live
 *   connection. The only state in which the marker may move.
 * - `stale` — there is a point, and it is too old, or the connection it came
 *   over is not live. Drawn where it was, labelled, never animated.
 * - `reconnecting` — the socket dropped and is coming back. Whatever point
 *   there is was received before the gap and is drawn as stale; the state that
 *   follows is decided by what arrives after the reconnect, not by this one.
 */
export type TrackingView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'live'; readonly position: MapPoint }
  | { readonly kind: 'stale'; readonly position: MapPoint }
  | { readonly kind: 'reconnecting'; readonly position: MapPoint | null };

export interface TrackingInputs {
  readonly status: OrderStatus;
  /** The last point received, or `null` if none has been. */
  readonly position: MapPoint | null;
  /** When that point reached this phone, by this phone's clock. */
  readonly receivedAt: number | null;
  readonly now: number;
  readonly connection: ConnectionStatus;
  /**
   * When `connection` entered its current status, by this phone's clock. Read
   * only while it is `live`: a point received before the connection last came
   * up crossed a gap to get here.
   */
  readonly connectionSince: number;
  /**
   * When the order's current master was first seen on this screen, by the same
   * clock. A point received before then belongs to somebody else — the master
   * a re-dispatch took the order away from — and is never drawn at all.
   */
  readonly masterSince: number;
}

/**
 * The one function that decides what the customer is told.
 *
 * **Freshness is measured from when the point arrived, not from the server's
 * `at`.** `at` is the server's clock and `now` is the phone's; a phone whose
 * clock runs a minute slow would draw a two-minute-old point as live, and a
 * phone that runs fast would never draw anything as live at all. The receipt
 * time is on one clock. It is still honest about age because the server never
 * holds a point back: the fan-out is leading-edge and nothing is replayed on
 * join, so a point is at most a network hop old when it arrives. `at` keeps its
 * one job, ordering (`sequence-guard.ts`).
 */
export function deriveTrackingView(inputs: TrackingInputs): TrackingView {
  const { status, now, connection, connectionSince, masterSince } = inputs;

  if (!isTrackedStatus(status)) {
    return { kind: 'hidden' };
  }

  /**
   * **A point from a previous master is not this master's last position.** The
   * cache entry is keyed by order, and a re-dispatch keeps the order: when the
   * customer's socket misses `A → SEARCHING → B accepted`, the refetch after
   * the gap goes straight from A on the way to B accepted, the status stays
   * tracked, and A's last point is still in the entry. Drawing it under B's
   * order would show one master's location to a customer they no longer serve
   * (CLAUDE.md §11). So it is treated as no point at all.
   */
  const ownPoint =
    inputs.position !== null && inputs.receivedAt !== null && inputs.receivedAt >= masterSince;
  const position = ownPoint ? inputs.position : null;
  const receivedAt = ownPoint ? inputs.receivedAt : null;

  if (connection === 'reconnecting') {
    return { kind: 'reconnecting', position };
  }

  if (position === null || receivedAt === null) {
    return { kind: 'absent' };
  }

  /**
   * **A point from before a gap is never live after it**, however young it is
   * by the clock. The socket cannot replay what it missed and the position has
   * no endpoint to refetch (`RealtimeProvider`'s `onResumed`), so the only
   * point that may be called live after a reconnect is one that arrived over
   * the restored connection. Until then the old one is drawn as last known.
   */
  if (
    connection !== 'live' ||
    receivedAt < connectionSince ||
    now - receivedAt > POSITION_FRESHNESS_MS
  ) {
    return { kind: 'stale', position };
  }

  return { kind: 'live', position };
}

/**
 * The point `fraction` of the way from `from` to `to`, clamped to the segment.
 *
 * **Linear in latitude and longitude, which is wrong on a globe and right
 * here.** Consecutive points are a fan-out window apart — a few hundred metres
 * at city speed — and over that distance the difference between a straight
 * line in degrees and a great-circle arc is far below what a map at street zoom
 * can draw.
 */
export function interpolatePoint(from: MapPoint, to: MapPoint, fraction: number): MapPoint {
  const t = Math.min(1, Math.max(0, fraction));
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * t,
    longitude: from.longitude + (to.longitude - from.longitude) * t,
  };
}

/**
 * Whether the marker glides to a new point or is placed on it.
 *
 * **It glides only from a point that was live when the new one arrived.** A
 * glide draws a path, and a path from a stale point is a journey the screen
 * invented: the master may have been anywhere during the gap. So the first
 * point, the first point after a stale spell or a reconnect, and any point
 * that is not itself live are placed, not animated.
 */
export function planMarkerMove(input: {
  readonly hasDrawnPoint: boolean;
  readonly previousWasLive: boolean;
  readonly nextIsLive: boolean;
}): 'glide' | 'place' {
  return input.hasDrawnPoint && input.previousWasLive && input.nextIsLive ? 'glide' : 'place';
}
