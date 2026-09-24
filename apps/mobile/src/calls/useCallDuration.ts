import { useEffect, useState } from 'react';

/** How often the running time is re-read. The display has one-second resolution. */
export const CALL_DURATION_TICK_MS = 1_000;

/**
 * Milliseconds since `connectedAt`, re-read once a second — or `null` for a
 * call that never got into the room.
 *
 * **Derived, never counted** (#188). The reducer holds the one fact, when this
 * phone got into the room; this hook only re-reads the clock against it. A
 * counter incremented per tick would drift the moment a tick was late — a
 * backgrounded app, a busy JS thread on a mid-range Android — and would be a
 * second source of truth disagreeing with the first. The duration is never sent
 * anywhere either: the server computes its own.
 *
 * `now` is injectable so a story or a test can pin the clock.
 */
export function useCallDuration(
  connectedAt: number | null,
  now: () => number = Date.now,
): number | null {
  const [current, setCurrent] = useState(now);

  useEffect(() => {
    if (connectedAt === null) {
      return;
    }
    setCurrent(now());
    const timer = setInterval(() => {
      setCurrent(now());
    }, CALL_DURATION_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [connectedAt, now]);

  return connectedAt === null ? null : current - connectedAt;
}
