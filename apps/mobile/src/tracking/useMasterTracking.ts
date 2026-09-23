import type { OrderStatus } from '@tezusta/types';
import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useState } from 'react';

import { monotonicNow } from '../lib/monotonic-clock';
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
 * **One timer at a time, re-armed until it is right.** The only thing that
 * turns a live point stale without a new frame is time passing. The hook
 * schedules a re-render for the moment the point crosses the window and, when
 * it fires, checks again: a timer that fired early — throttled in the
 * background, or drifting — re-arms itself rather than leaving the point
 * "live" until something else happens to render. Every reading is from
 * `monotonicNow()`, so a wall clock stepped backwards cannot make a point
 * younger.
 *
 * **A new master starts from nothing.** `masterId` is the order's own field,
 * from the order the screen already reads. When it changes — a re-dispatch,
 * possibly one the socket missed and the refetch revealed — the moment is
 * remembered, and any point received before it is not drawn
 * (`deriveTrackingView`'s `masterSince`).
 */
export function useMasterTracking(
  orderId: string,
  status: OrderStatus,
  masterId: string | null,
): TrackingView {
  const tracked = isTrackedStatus(status);
  const { currentData } = useMasterPositionQuery(tracked ? orderId : skipToken);
  const connection = useAppSelector(selectConnectionStatus);
  const [now, setNow] = useState(monotonicNow);

  /**
   * When the connection entered its current status, and when the current
   * master was first seen.
   *
   * Recorded during render — React's pattern for state derived from a
   * changing input — rather than in an effect, because an effect would commit
   * one frame in which a reconnected socket (or a new master) and a point from
   * before the change were read together, and that frame is exactly the lie
   * `deriveTrackingView` rules out.
   */
  const [connectionEpoch, setConnectionEpoch] = useState(() => ({
    connection,
    since: monotonicNow(),
  }));
  if (connectionEpoch.connection !== connection) {
    setConnectionEpoch({ connection, since: monotonicNow() });
  }

  const [masterEpoch, setMasterEpoch] = useState(() => ({ masterId, since: monotonicNow() }));
  if (masterEpoch.masterId !== masterId) {
    setMasterEpoch({ masterId, since: monotonicNow() });
  }

  const position = tracked ? (currentData ?? null) : null;
  const receivedAt = position?.receivedAt ?? null;

  useEffect(() => {
    if (receivedAt === null || now - receivedAt > POSITION_FRESHNESS_MS) {
      // Nothing to watch, or already judged stale: no timer to hold.
      return;
    }

    // One millisecond past the boundary: `deriveTrackingView` calls a point
    // stale when it is *older* than the window, not when it is exactly as old.
    const turnsStaleIn = Math.max(0, receivedAt + POSITION_FRESHNESS_MS - monotonicNow() + 1);
    const timer = setTimeout(() => {
      setNow(monotonicNow());
    }, turnsStaleIn);

    return () => {
      clearTimeout(timer);
    };
  }, [receivedAt, now]);

  const sameConnection = connectionEpoch.connection === connection;
  const sameMaster = masterEpoch.masterId === masterId;

  return deriveTrackingView({
    status,
    position,
    receivedAt,
    now,
    connection,
    connectionSince: sameConnection ? connectionEpoch.since : monotonicNow(),
    masterSince: sameMaster ? masterEpoch.since : monotonicNow(),
  });
}
