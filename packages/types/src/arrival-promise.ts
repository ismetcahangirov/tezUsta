/**
 * When the assigned master promised to arrive, as both parties read it
 * (issue #396,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 8–13).
 *
 * Fixed once, after the accept: the accept time plus the road travel time plus
 * a 30-second buffer. Nobody types it and nobody can change it. Null from the
 * accept until the job that computes it has run (a few seconds), and null
 * again after a re-dispatch.
 */
export interface ArrivalPromise {
  /** ISO-8601. Formatted as a clock time on the phone, never used to count down. */
  readonly promisedAt: string;
  /**
   * Seconds from **the server's** "now", at the moment it answered, to
   * `promisedAt`. Negative once the promise has passed.
   *
   * This is what a phone counts down from, anchored to its monotonic clock on
   * receipt, because the phone's wall clock may be minutes off (ADR-0055 § 13).
   */
  readonly secondsRemaining: number;
  /**
   * `route` from a road route; `estimate` when routing failed and the generous
   * straight-line estimate stood in. An audit fact: neither app shows it.
   */
  readonly source: ArrivalPromiseSource;
}

export type ArrivalPromiseSource = 'route' | 'estimate';
