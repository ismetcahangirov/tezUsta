/**
 * The recurring jobs on the `maintenance` queue.
 *
 * Each name is also its scheduler's id (`RecurringWorkService.every`), so
 * these strings are written into Redis and survive a deploy: renaming one
 * leaves the old scheduler running under the old name with nothing registered
 * to handle it, which the processor answers with `UnknownDeferredJobError` on
 * every iteration. Rename by stopping the old id in the same release that
 * introduces the new one.
 */
export const AUTH_RETENTION_JOB = 'maintenance-auth-retention';
export const GEOCODE_CACHE_SWEEP_JOB = 'maintenance-geocode-cache';
export const ORDER_PHOTO_SWEEP_JOB = 'maintenance-order-photos';

/** Every job this module owns — what it registers, schedules, and stops. */
export const MAINTENANCE_JOBS = [
  AUTH_RETENTION_JOB,
  GEOCODE_CACHE_SWEEP_JOB,
  ORDER_PHOTO_SWEEP_JOB,
] as const;

/**
 * The most batches one sweep run will take before it stops and leaves the
 * rest to the next interval.
 *
 * A sweep that loops until the table is clean is a sweep that, on the day a
 * retention window is shortened, runs for an hour holding a worker slot and
 * writing to a hot table the whole time. Stopping early is free: the backlog
 * is still there next interval, and `MAINTENANCE_BATCH_SIZE` times this is
 * the real per-run ceiling an operator is choosing.
 */
export const MAX_BATCHES_PER_RUN = 50;
