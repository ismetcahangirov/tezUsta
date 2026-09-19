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
 * A handler for one job name on the dispatch queue.
 *
 * It must be **idempotent**: BullMQ retries, and a stalled job is re-delivered
 * to another worker. Throwing is the way to ask for a retry; returning
 * normally marks the job complete.
 */
export type DeferredJobHandler = (payload: DeferredJobPayload) => Promise<void>;
