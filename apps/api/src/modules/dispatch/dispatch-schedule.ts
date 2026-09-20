/**
 * When each broadcast wave happens, and how wide it looks — derived from
 * configuration, never from a literal
 * ([ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)).
 *
 * **Pure, and deliberately so.** Everything here is a function of four numbers
 * and a clock reading, which is what lets the timings be asserted in
 * milliseconds without a database, a queue or a fake timer — and what lets the
 * engine and the offer feed derive the same answer from the same inputs
 * instead of one of them trusting the other.
 */

/** The four dispatch parameters ADR-0009 §Parameters names, as configured. */
export interface DispatchTimings {
  readonly initialRadiusM: number;
  readonly maxRadiusM: number;
  readonly radiusStepSeconds: number;
  readonly totalTimeoutSeconds: number;
}

/** One broadcast round: when it fires, and how far it reaches. */
export interface DispatchWave {
  /** 1-based. Written to `order_offers.round`. */
  readonly round: number;
  /** Milliseconds after the order entered `SEARCHING`. Wave 1 is zero. */
  readonly offsetMs: number;
  readonly radiusM: number;
}

/**
 * How many broadcasts one search makes.
 *
 * Wave 1 fires the moment the order enters `SEARCHING`, and a further wave
 * fires every `DISPATCH_RADIUS_STEP_SECONDS` until the give-up deadline. With
 * the shipped defaults — 180 seconds total, a 30-second step — that is six
 * waves, at t = 0, 30, 60, 90, 120 and 150, with the deadline at 180.
 *
 * `ceil` rather than `floor`: a step that does not divide the timeout evenly
 * leaves a final, shorter interval, and a customer whose order is still
 * searching in it is better served by one more broadcast than by silence.
 * Never fewer than one — a step longer than the whole window still owes the
 * order its first broadcast.
 */
export function dispatchWaveCount(timings: DispatchTimings): number {
  return Math.max(1, Math.ceil(timings.totalTimeoutSeconds / timings.radiusStepSeconds));
}

/**
 * The radius round `round` broadcasts at.
 *
 * **Why this is derived rather than configured.** ADR-0009 fixes an initial
 * radius, a maximum, and how often the radius widens — but not by how much.
 * Adding a `DISPATCH_RADIUS_STEP_M` would be a fifth parameter that can
 * silently contradict the other four: set it too small and the search never
 * reaches `DISPATCH_MAX_RADIUS_M` before giving up, so the maximum becomes
 * decoration; set it too large and the last rounds all sit at the ceiling,
 * broadcasting the same circle repeatedly. Sweeping linearly from the initial
 * radius to the maximum across the rounds the window actually contains keeps
 * all four values true at once: the first round is the initial radius, the
 * last round is exactly the maximum, and no round exceeds it.
 *
 * With the shipped defaults that is 3000, 4400, 5800, 7200, 8600, 10000 m.
 *
 * A single-wave search stays at the initial radius: there is no widening to
 * interpolate across, and jumping straight to the maximum would broadcast a
 * 10 km circle for an order that was never allowed a second round.
 *
 * A configuration whose initial radius exceeds its maximum is not rejected
 * here — `env.schema.ts` validates each value on its own and this function is
 * not the place to start refusing combinations at boot. It is clamped
 * instead, which is also what `NearbyMastersRepository` does with the radius
 * it is handed.
 */
export function dispatchRadiusForRound(round: number, timings: DispatchTimings): number {
  const waves = dispatchWaveCount(timings);
  const ceiling = timings.maxRadiusM;
  const start = Math.min(timings.initialRadiusM, ceiling);

  if (waves === 1) {
    return start;
  }

  const clamped = Math.min(Math.max(Math.trunc(round), 1), waves);
  const widened = start + ((ceiling - start) * (clamped - 1)) / (waves - 1);

  return Math.min(ceiling, Math.round(widened));
}

/** Every wave of one search, in order. Wave 1 first, at offset zero. */
export function dispatchWavePlan(timings: DispatchTimings): readonly DispatchWave[] {
  const stepMs = timings.radiusStepSeconds * 1000;

  return Array.from({ length: dispatchWaveCount(timings) }, (_unused, index) => ({
    round: index + 1,
    offsetMs: index * stepMs,
    radiusM: dispatchRadiusForRound(index + 1, timings),
  }));
}

/**
 * The round the clock implies, `elapsedMs` after the order entered
 * `SEARCHING`.
 *
 * **This, not the round in the job payload, is what a wave broadcasts at.** At
 * least-once delivery and a busy worker both mean a tick can arrive late, and
 * a late tick that used its scheduled round would broadcast a circle narrower
 * than the search has actually reached — a master inside the current radius
 * would be skipped because a queue was slow. Deriving the round from the
 * searching-since timestamp makes the radius a function of the clock, which is
 * the only thing two replicas are guaranteed to agree about.
 *
 * Clamped at both ends: a negative elapsed time (clock skew between the
 * database and a worker) is round 1, and anything past the last wave is the
 * last wave.
 */
export function dispatchRoundAtElapsed(elapsedMs: number, timings: DispatchTimings): number {
  const stepMs = timings.radiusStepSeconds * 1000;
  const waves = dispatchWaveCount(timings);

  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 1;
  }

  return Math.min(waves, Math.floor(elapsedMs / stepMs) + 1);
}

/**
 * The radius a search begun at `searchingSince` is entitled to at `now`.
 *
 * Exported for the **read path** as well as the engine: an offer feed that
 * served whatever `order_offers.radius_m` happened to say would be trusting
 * that the wave which wrote it ran on time. Bounding the feed by this instead
 * means a tick delayed by a busy worker can never let a reader serve a radius
 * the clock does not imply (issue #103).
 */
export function currentDispatchRadiusM(
  searchingSince: Date,
  now: Date,
  timings: DispatchTimings,
): number {
  return dispatchRadiusForRound(
    dispatchRoundAtElapsed(now.getTime() - searchingSince.getTime(), timings),
    timings,
  );
}

/** When the search gives up, if nobody has accepted by then. */
export function dispatchDeadline(searchingSince: Date, timings: DispatchTimings): Date {
  return new Date(searchingSince.getTime() + timings.totalTimeoutSeconds * 1000);
}

/**
 * When an offer written at `now` stops being live.
 *
 * **One wave interval, and never past the search's own deadline.** An offer is
 * live for exactly as long as it takes the next wave to re-offer it, which is
 * what makes "an unactioned offer expires rather than lingering in a master's
 * list" (ADR-0009) true without a job per offer: expiry is a column the feed
 * filters on, and the next wave is what renews it for a master still in range.
 *
 * The deadline cap is what stops a final-wave offer outliving the order it
 * belongs to — a master tapping accept on an offer whose order is already
 * `NO_MASTER_FOUND` is a support ticket, and the conditional guard on the
 * accept path should not be the only thing preventing it.
 */
export function offerExpiresAt(now: Date, searchingSince: Date, timings: DispatchTimings): Date {
  const deadline = dispatchDeadline(searchingSince, timings);
  const oneWave = new Date(now.getTime() + timings.radiusStepSeconds * 1000);

  return oneWave.getTime() < deadline.getTime() ? oneWave : deadline;
}
