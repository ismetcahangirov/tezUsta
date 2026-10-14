/**
 * What a deferred job carries.
 *
 * `Record<string, unknown>` rather than a union of every job's payload,
 * because this module deliberately knows nothing about dispatch. The handler
 * that registers for a job name is what narrows it, with the same Zod
 * discipline used at the HTTP boundary — a job payload has been through Redis
 * and is no more trusted than a request body.
 *
 * `backend-architecture.md` § Background jobs already fixes the rule this
 * shape exists to allow: **jobs carry ids, never whole objects**, because the
 * object may have changed by the time the job runs. A deferred dispatch tick
 * carries an order id, not an order.
 */
export type DeferredJobPayload = Record<string, unknown>;

/**
 * Where a run sits among its retries. Most handlers ignore it; a handler that
 * must record a terminal outcome — the media pipeline marking an upload
 * failed (#305) — reads it to know that this attempt is the last one.
 */
export interface DeferredJobContext {
  /** 1 on the first run. */
  readonly attempt: number;
  /** `QUEUE_JOB_ATTEMPTS` as the job was enqueued with it. */
  readonly maxAttempts: number;
}

/**
 * A handler for one job name.
 *
 * It must be **idempotent**: BullMQ retries, and a stalled job is re-delivered
 * to another worker. Throwing is the way to ask for a retry; returning
 * normally marks the job complete; throwing {@link PermanentJobError} ends it
 * without a retry.
 */
export type DeferredJobHandler = (
  payload: DeferredJobPayload,
  // Optional because a test calls a handler directly, as the job it is,
  // without a queue around it; the worker always passes it. A handler that
  // reads it treats its absence as a single attempt — the only one there is.
  context?: DeferredJobContext,
) => Promise<void>;

/**
 * A failure that another attempt cannot fix: a corrupt image is as corrupt on
 * the third try. The processor turns it into BullMQ's own
 * `UnrecoverableError`, so the job goes straight to the failed set — and a
 * handler outside `infra/queue` never imports BullMQ to say so.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
    Object.setPrototypeOf(this, PermanentJobError.prototype);
  }
}
