/**
 * How far a master's new fix is from their previous one, and how long ago that
 * previous one was taken — both measured by the database, in the transaction
 * that would write the new row (`MasterLocationRepository.record`).
 */
export interface PositionStep {
  /** Great-circle distance, metres (`ST_Distance` on `geography`). */
  readonly distanceMeters: number;
  /** Server time between the previous row's `recorded_at` and now. */
  readonly elapsedSeconds: number;
}

export interface PlausibilityLimits {
  /** `MASTER_LOCATION_MAX_SPEED_KMH`. */
  readonly maxSpeedKmh: number;
  /** `MASTER_LOCATION_JUMP_FLOOR_M`. */
  readonly jumpFloorMeters: number;
}

/**
 * Whether a position report describes a move no master could have made
 * (issue #274, [ADR-0044](docs/decisions/ADR-0044-location-plausibility.md)).
 *
 * **Both conditions, never either.** A step is implausible only when it is
 * *longer than the floor* **and** *faster than the ceiling*:
 *
 * - The floor is what keeps GPS jitter out. A phone that wanders a few hundred
 *   metres between two fixes a second apart is doing the ordinary thing a
 *   phone indoors or among tall buildings does, and on paper that is hundreds
 *   of km/h. Speed alone would refuse it.
 * - The ceiling is what keeps real driving in. Distance alone would refuse a
 *   master on the Baku–Sumqayıt road the first time a report was late.
 *
 * Written as "distance past what the ceiling allows in the time that passed"
 * rather than as a division, so a zero-second step — a retry landing in the
 * same transaction tick — needs no special case: the allowance is zero, and
 * the floor alone decides.
 *
 * **The allowance grows with elapsed time**, which is the property the ADR
 * leans on: a refused jump pins the master to their last accepted fix only
 * until enough time has passed for the jump to have been drivable. A phone
 * that genuinely went somewhere fast is accepted again, without anybody
 * having to clear anything.
 */
export function isImplausibleJump(step: PositionStep, limits: PlausibilityLimits): boolean {
  if (step.distanceMeters <= limits.jumpFloorMeters) {
    return false;
  }

  // Both sides scaled by 3 600 rather than dividing km/h into m/s, so the
  // comparison at the exact boundary is not decided by a rounding error.
  const allowedMetresTimes3600 = limits.maxSpeedKmh * 1_000 * Math.max(step.elapsedSeconds, 0);

  return step.distanceMeters * 3_600 > allowedMetresTimes3600;
}
