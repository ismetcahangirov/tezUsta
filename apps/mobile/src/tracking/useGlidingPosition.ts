import { useEffect, useRef, useState } from 'react';

import type { MapPoint } from './map-surface.types';
import {
  interpolatePoint,
  MARKER_GLIDE_MS,
  MARKER_TICK_MS,
  planMarkerMove,
} from './tracking-policy';

/**
 * Where the master's marker is drawn, given where the master was last reported
 * (issue #172).
 *
 * **Smoothness is a rendering problem, and this is where it is solved.** The
 * server sends one point per fan-out window on purpose
 * (`realtime-architecture.md` § The server → customer throttle); drawing only
 * those would make the marker jump every fifteen seconds and stand still in
 * between. So between two points the marker travels, in {@link MARKER_TICK_MS}
 * steps, over {@link MARKER_GLIDE_MS} — and the update rate on the wire does
 * not change.
 *
 * **`live` is the licence to move.** When the point is not live — stale, or
 * received before a reconnect — the marker is placed on it and stays there;
 * a glide already running is cut short onto its destination, which is a real
 * point, rather than finishing a path the screen can no longer vouch for. And
 * the first point after a spell of not-live is placed rather than glided to
 * (`planMarkerMove`), because a path from an old point is a route the master
 * may never have taken.
 *
 * **It owns one interval and clears it** on every new point, on losing `live`,
 * and on unmount — a timer that outlived the screen would keep a popped screen
 * rendering on a device that cannot spare it.
 */
export function useGlidingPosition(target: MapPoint | null, live: boolean): MapPoint | null {
  const [drawn, setDrawn] = useState<MapPoint | null>(target);
  const drawnRef = useRef<MapPoint | null>(target);
  const wasLiveRef = useRef(live);

  useEffect(() => {
    const previousWasLive = wasLiveRef.current;
    wasLiveRef.current = live;

    function draw(point: MapPoint | null): void {
      drawnRef.current = point;
      setDrawn(point);
    }

    const from = drawnRef.current;
    if (target === null) {
      draw(null);
      return;
    }

    const move = planMarkerMove({
      hasDrawnPoint: from !== null,
      previousWasLive,
      nextIsLive: live,
    });

    if (move === 'place' || from === null) {
      draw(target);
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const fraction = (Date.now() - startedAt) / MARKER_GLIDE_MS;
      draw(interpolatePoint(from, target, fraction));
      if (fraction >= 1) {
        clearInterval(timer);
      }
    }, MARKER_TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [target, live]);

  return drawn;
}
