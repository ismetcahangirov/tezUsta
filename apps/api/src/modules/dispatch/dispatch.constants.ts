/**
 * The two deferred jobs the dispatch engine registers, and the ids it gives
 * them.
 *
 * **The ids are a function of the order and its search, never of a counter.**
 * `DeferredWorkService.schedule` collapses two enqueues sharing an id into one
 * job, so a deterministic id is what makes "schedule the search" safe to run
 * twice — two API replicas reacting to the same order, or a retry of the
 * request that created it, produce one set of jobs rather than two searches
 * racing each other (ADR-0009, CLAUDE.md §12).
 *
 * The search's start time is part of every id, so a re-dispatch (EPIC 8) gets
 * its own jobs rather than colliding with the ids the previous search already
 * used and being silently dropped.
 *
 * Hyphens, not colons: BullMQ composes its Redis keys as
 * `<prefix>:<queue>:<id>`, and an id carrying the separator makes a key that
 * cannot be read back apart by eye during an incident.
 */
export const DISPATCH_WAVE_JOB = 'dispatch-wave';
export const DISPATCH_GIVE_UP_JOB = 'dispatch-give-up';

export function dispatchWaveJobId(
  orderId: string,
  searchingSinceMs: number,
  round: number,
): string {
  return `${DISPATCH_WAVE_JOB}-${orderId}-${String(searchingSinceMs)}-${String(round)}`;
}

export function dispatchGiveUpJobId(orderId: string, searchingSinceMs: number): string {
  return `${DISPATCH_GIVE_UP_JOB}-${orderId}-${String(searchingSinceMs)}`;
}

/**
 * The largest `round` a wave payload may claim.
 *
 * **A sanity bound on an untrusted value, not a derived limit.** The wave
 * count is a function of `DISPATCH_TOTAL_TIMEOUT_SECONDS` and
 * `DISPATCH_RADIUS_STEP_SECONDS`, and neither is bounded above by
 * `env.schema.ts`, so there is no configuration-derived ceiling to check
 * against — and the round a wave actually broadcasts at comes from the clock
 * regardless (`dispatch-schedule.ts`), so an absurd payload round changes
 * nothing but a job id and a log line. Which is exactly why it is worth
 * refusing: a job payload has been through another process and a datastore,
 * and an unbounded integer from one has no business reaching a log line.
 */
export const MAX_DISPATCH_ROUND = 10_000;
