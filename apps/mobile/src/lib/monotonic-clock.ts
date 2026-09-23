/**
 * Milliseconds on a clock that only moves forward (issue #172).
 *
 * **For measuring how long ago something happened on this phone, never for
 * telling the time.** `Date.now()` is the wall clock: NTP corrections, a
 * manual change or a time-zone sync can step it backwards, and an age measured
 * across that step comes out too young — which on the tracking map means a
 * stale position drawn as live. `performance.now()` is monotonic by
 * specification and is provided by React Native's runtime (and faked by Jest's
 * modern timers alongside `Date`), so every age the tracking surface computes
 * reads this one clock.
 */
export function monotonicNow(): number {
  return performance.now();
}
