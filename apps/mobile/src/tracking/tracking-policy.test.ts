import type { OrderStatus } from '@tezusta/types';

import { LOCATION_BUDGET } from '../location/location-budget';
import {
  deriveTrackingView,
  interpolatePoint,
  isTrackedStatus,
  MARKER_GLIDE_MS,
  planMarkerMove,
  POSITION_FRESHNESS_MS,
  SERVER_POSITION_FANOUT_SECONDS,
  type TrackingInputs,
} from './tracking-policy';

const POINT = { latitude: 40.4093, longitude: 49.8671 };
const NOW = 1_000_000;

function inputs(overrides: Partial<TrackingInputs> = {}): TrackingInputs {
  return {
    status: 'MASTER_ON_THE_WAY',
    position: POINT,
    receivedAt: NOW - 1_000,
    now: NOW,
    connection: 'live',
    connectionSince: NOW - 60_000,
    masterSince: NOW - 120_000,
    ...overrides,
  };
}

describe('which statuses show the map', () => {
  const TRACKED: readonly OrderStatus[] = ['ACCEPTED', 'MASTER_ON_THE_WAY'];
  const NOT_TRACKED: readonly OrderStatus[] = [
    'DRAFT',
    'SEARCHING',
    'MASTER_ARRIVED',
    'IN_PROGRESS',
    'COMPLETED',
    'PAYMENT_PENDING',
    'PAID',
    'DISPUTED',
    'RESOLVED',
    'REFUNDED',
    'NO_MASTER_FOUND',
    'CANCELLED',
  ];

  it.each(TRACKED)('shows it while the order is %s', (status) => {
    expect(isTrackedStatus(status)).toBe(true);
  });

  it.each(NOT_TRACKED)('hides it while the order is %s', (status) => {
    expect(isTrackedStatus(status)).toBe(false);
    expect(deriveTrackingView(inputs({ status }))).toEqual({ kind: 'hidden' });
  });
});

describe('the freshness window', () => {
  /**
   * The derivation, asserted as arithmetic so a change to either input is a
   * visible change here: the worst healthy gap between two broadcasts is one
   * fan-out window plus one travelling floor, and one more floor is tolerance.
   */
  it('is one fan-out window plus two travelling floors', () => {
    const floor = LOCATION_BUDGET.travelling?.floorSeconds ?? 0;
    expect(POSITION_FRESHNESS_MS).toBe((SERVER_POSITION_FANOUT_SECONDS + 2 * floor) * 1000);
    expect(POSITION_FRESHNESS_MS).toBe(39_000);
  });

  it('outlasts a glide, so the marker is never moving towards a stale point', () => {
    expect(MARKER_GLIDE_MS).toBeLessThan(POSITION_FRESHNESS_MS);
  });
});

describe('what the customer is told', () => {
  it('is live for a recent point over a live connection', () => {
    expect(deriveTrackingView(inputs())).toEqual({ kind: 'live', position: POINT });
  });

  it('is live at exactly the edge of the window', () => {
    const view = deriveTrackingView(inputs({ receivedAt: NOW - POSITION_FRESHNESS_MS }));
    expect(view.kind).toBe('live');
  });

  it('is stale one millisecond past the window', () => {
    const view = deriveTrackingView(inputs({ receivedAt: NOW - POSITION_FRESHNESS_MS - 1 }));
    expect(view).toEqual({ kind: 'stale', position: POINT });
  });

  it('is absent when no point has arrived', () => {
    expect(deriveTrackingView(inputs({ position: null, receivedAt: null }))).toEqual({
      kind: 'absent',
    });
  });

  it('is absent with no socket at all, rather than an error', () => {
    const view = deriveTrackingView(
      inputs({ position: null, receivedAt: null, connection: 'offline' }),
    );
    expect(view).toEqual({ kind: 'absent' });
  });

  it('says reconnecting while the socket is coming back, keeping the last point', () => {
    expect(deriveTrackingView(inputs({ connection: 'reconnecting' }))).toEqual({
      kind: 'reconnecting',
      position: POINT,
    });
  });

  it('says reconnecting with no point to show, too', () => {
    const view = deriveTrackingView(
      inputs({ connection: 'reconnecting', position: null, receivedAt: null }),
    );
    expect(view).toEqual({ kind: 'reconnecting', position: null });
  });

  /**
   * A point is only as live as the connection it would be replaced over. With
   * the socket gone and not coming back on its own, nothing will move it, and
   * calling it live would be the lie this state exists to prevent.
   */
  it.each(['offline', 'connecting'] as const)(
    'never calls a point live over a %s connection',
    (connection) => {
      expect(deriveTrackingView(inputs({ connection })).kind).toBe('stale');
    },
  );

  /**
   * The regression the rule exists for: a gap shorter than the window leaves a
   * point that is young by the clock and still crossed the gap. Only a point
   * received over the restored connection may be called live.
   */
  it('never calls a point from before a reconnect live, however young', () => {
    const view = deriveTrackingView(
      inputs({ receivedAt: NOW - 1_000, connectionSince: NOW - 500 }),
    );
    expect(view).toEqual({ kind: 'stale', position: POINT });
  });

  it('calls a point received over the restored connection live', () => {
    const view = deriveTrackingView(inputs({ receivedAt: NOW - 100, connectionSince: NOW - 500 }));
    expect(view.kind).toBe('live');
  });

  /**
   * Re-dispatch during a socket gap: the entry still holds the previous
   * master's point when the refetch names a new one.
   */
  it('draws nothing from a master the order has since moved away from', () => {
    const view = deriveTrackingView(inputs({ receivedAt: NOW - 1_000, masterSince: NOW - 500 }));
    expect(view).toEqual({ kind: 'absent' });
  });

  it('does not keep a previous master’s point even while reconnecting', () => {
    const view = deriveTrackingView(
      inputs({ connection: 'reconnecting', receivedAt: NOW - 1_000, masterSince: NOW - 500 }),
    );
    expect(view).toEqual({ kind: 'reconnecting', position: null });
  });

  it('hides even a fresh point once the order is over', () => {
    expect(deriveTrackingView(inputs({ status: 'COMPLETED' }))).toEqual({ kind: 'hidden' });
  });
});

describe('moving the marker', () => {
  const FROM = { latitude: 40, longitude: 49 };
  const TO = { latitude: 41, longitude: 51 };

  it('starts on the old point and ends on the new one', () => {
    expect(interpolatePoint(FROM, TO, 0)).toEqual(FROM);
    expect(interpolatePoint(FROM, TO, 1)).toEqual(TO);
  });

  it('is halfway at half the glide', () => {
    expect(interpolatePoint(FROM, TO, 0.5)).toEqual({ latitude: 40.5, longitude: 50 });
  });

  it('never overshoots the reported point, however late the tick', () => {
    expect(interpolatePoint(FROM, TO, 1.7)).toEqual(TO);
    expect(interpolatePoint(FROM, TO, -0.2)).toEqual(FROM);
  });

  it('glides only between two live points', () => {
    expect(planMarkerMove({ hasDrawnPoint: true, previousWasLive: true, nextIsLive: true })).toBe(
      'glide',
    );
  });

  it.each([
    ['the first point', { hasDrawnPoint: false, previousWasLive: true, nextIsLive: true }],
    [
      'the first point after a stale spell',
      { hasDrawnPoint: true, previousWasLive: false, nextIsLive: true },
    ],
    [
      'a point that is not itself live',
      { hasDrawnPoint: true, previousWasLive: true, nextIsLive: false },
    ],
  ] as const)('places %s rather than animating towards it', (_, input) => {
    expect(planMarkerMove(input)).toBe('place');
  });
});
