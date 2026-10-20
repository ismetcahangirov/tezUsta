import { z } from 'zod';

/**
 * The arrival-promise job's name, id and payload (#396, ADR-0055 § 8).
 *
 * Here rather than in the module that runs it, because two modules produce it
 * — the accept path (`modules/masters/offers`) and the backstop sweep — and
 * both already import `modules/orders`.
 */
export const ARRIVAL_PROMISE_JOB = 'arrival-promise';

/** The recurring sweep that re-asks for promises an accept failed to schedule. */
export const ARRIVAL_PROMISE_SWEEP_JOB = 'arrival-promise-sweep';

/**
 * One job per accept. `accepted_at` is the generation, as `searching_since`
 * is dispatch's: a re-dispatch and a second accept produce a new id, and a
 * late job for the first accept cannot be mistaken for the second. Hyphens,
 * not colons, because BullMQ composes its Redis keys with colons.
 */
export function arrivalPromiseJobId(orderId: string, acceptedAtMs: number): string {
  return `${ARRIVAL_PROMISE_JOB}-${orderId}-${String(acceptedAtMs)}`;
}

/**
 * Validated on the way out of Redis: a job payload has crossed a process and
 * a datastore, and a deploy is the ordinary way an old shape arrives.
 */
export const arrivalPromisePayloadSchema = z
  .object({
    orderId: z.uuid(),
    masterId: z.uuid(),
    acceptedAtMs: z.int().positive(),
  })
  .strict();

export type ArrivalPromisePayload = z.infer<typeof arrivalPromisePayloadSchema>;
