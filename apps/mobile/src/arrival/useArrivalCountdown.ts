import type { ArrivalPromise } from '@tezusta/types';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { formatMessageTime } from '../conversation/format-message-time';
import { monotonicNow } from '../lib/monotonic-clock';
import { anchorFor, countdownAt, type ArrivalCountdownState } from './arrival-countdown';

/** One tick a second: the finest unit either screen prints. */
export const COUNTDOWN_TICK_MS = 1_000;

export type ArrivalCountdown = ArrivalCountdownState & {
  /** The promised time of day, in the app's language and the phone's time zone; null while pending. */
  readonly clockTime: string | null;
};

/**
 * The arrival countdown both parties see (issue #399, ADR-0055 § 12–13).
 *
 * **Anchored on receipt.** Every time a new `promise` object arrives — an HTTP
 * read, or a socket frame patched into the cache — the hook takes the
 * server's `secondsRemaining` and pins it to this phone's monotonic clock.
 * Older frames never reach it: the realtime layer's ordering guard drops
 * them before they touch the cache.
 *
 * **Ticks once a second, and only while it is worth it**: while `active` (the
 * screen is focused) and the app is in the foreground. Returning to the
 * foreground re-derives from the anchor, so there is no catch-up; the order
 * and job reads also refetch on reconnect, which re-anchors in case the
 * monotonic clock paused while suspended.
 *
 * Isolated in the small component that prints it (`ArrivalCountdownRow`),
 * so a tick re-renders a line of text and never the map beside it.
 */
export function useArrivalCountdown(
  promise: ArrivalPromise | null,
  active = true,
): ArrivalCountdown {
  // Taken when the promise object changes — a new read or frame — and not on
  // a tick, which would only re-measure the same answer later.
  const anchor = useMemo(
    () => (promise === null ? null : anchorFor(promise.secondsRemaining, monotonicNow())),
    [promise],
  );

  const [now, setNow] = useState(() => monotonicNow());
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const ticking = anchor !== null && active && foreground;

  useEffect(() => {
    setNow(monotonicNow());
    if (!ticking) {
      return undefined;
    }
    const interval = setInterval(() => {
      setNow(monotonicNow());
    }, COUNTDOWN_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [ticking, anchor]);

  const countdown = countdownAt(anchor, now);
  return {
    ...countdown,
    clockTime: promise === null ? null : formatMessageTime(promise.promisedAt),
  };
}
