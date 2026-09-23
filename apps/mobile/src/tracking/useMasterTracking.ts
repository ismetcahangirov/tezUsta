import type { OrderStatus } from '@tezusta/types';
import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useState } from 'react';

import { selectConnectionStatus } from '../realtime/connection-slice';
import { useMasterPositionQuery } from '../realtime/tracking-endpoints';
import { useAppSelector } from '../store/hooks';
import {
  deriveTrackingView,
  isTrackedStatus,
  POSITION_FRESHNESS_MS,
  type TrackingView,
} from './tracking-policy';

/**
 * What the tracking surface should say about one order, right now (issue #172).
 *
 * **Read from the one cache, not fed by the socket** (ADR-0017). The position
 * is the RTK Query entry `applyRealtimeEvent` writes into and the order's
 * status is the entry the order screen already reads — this hook adds no store
 * of its own, and with the socket down it simply finds nothing, which is the
 * `absent` state rather than an error.
 *
 * **Subscribed only while the status is tracked.** Outside those statuses the
 * entry is not subscribed at all, and `keepUnusedDataFor: 0` drops the last
 * point the moment nothing reads it — so after an arrival or a terminal status
 * the master's position is not merely hidden, it is no longer held.
 *
 * **One timer, not a clock.** The only thing that turns a live point stale
 * without a new frame is time passing, and it passes at one known moment:
 * `receivedAt + POSITION_FRESHNESS_MS`. The hook schedules a single re-render
 * for then instead of ticking, and the next frame re-arms it.
 */
export function useMasterTracking(orderId: string, status: OrderStatus): TrackingView {
  const tracked = isTrackedStatus(status);
  const { currentData } = useMasterPositionQuery(tracked ? orderId : skipToken);
  const connection = useAppSelector(selectConnectionStatus);
  const [now, setNow] = useState(() => Date.now());

  /**
   * When the connection entered its current status.
   *
   * Recorded during render — React's pattern for state derived from a
   * changing input — rather than in an effect, because an effect would commit
   * one frame in which a reconnected socket and a point from before the gap
   * were read together and called live, and that frame is exactly the lie
   * `deriveTrackingView` rules out.
   */
  const [epoch, setEpoch] = useState(() => ({ connection, since: Date.now() }));
  if (epoch.connection !== connection) {
    setEpoch({ connection, since: Date.now() });
  }

  const position = tracked ? (currentData ?? null) : null;
  const receivedAt = position?.receivedAt ?? null;

  useEffect(() => {
    if (receivedAt === null) {
      return;
    }

    // One millisecond past the boundary: `deriveTrackingView` calls a point
    // stale when it is *older* than the window, not when it is exactly as old.
    // A point that is already past it is re-judged on the next tick rather
    // than trusted until something else happens to render.
    const turnsStaleIn = Math.max(0, receivedAt + POSITION_FRESHNESS_MS - Date.now() + 1);
    const timer = setTimeout(() => {
      setNow(Date.now());
    }, turnsStaleIn);

    return () => {
      clearTimeout(timer);
    };
  }, [receivedAt]);

  return deriveTrackingView({
    status,
    position,
    receivedAt,
    now,
    connection,
    connectionSince: epoch.connection === connection ? epoch.since : Date.now(),
  });
}
