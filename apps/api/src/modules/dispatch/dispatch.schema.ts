import { z } from 'zod';

import { MAX_DISPATCH_ROUND } from './dispatch.constants';

/**
 * What a dispatch job carries, validated on the way **out of** Redis.
 *
 * A job payload has been through another process and a datastore, so it is no
 * more trusted than a request body — `queue.types.ts` says so in as many
 * words, and CLAUDE.md §11 does not carve out an exception for work this
 * service enqueued itself. A deploy is the ordinary way an untrusted payload
 * appears: a job enqueued by the previous release, picked up by this one.
 *
 * **Ids, never objects.** Both payloads name an order and the search it
 * belongs to; everything else is re-read when the tick runs, because the order
 * will have changed by then — that is the entire point of a delayed job
 * (`backend-architecture.md` § Background jobs).
 *
 * Both are `.strict()`, for the same reason a request body is: a payload
 * carrying a key this release does not know about is a payload written by
 * something that disagrees with this release about what a dispatch job is, and
 * silently dropping the extra key is how that disagreement stays invisible
 * until it matters.
 */
export const dispatchWavePayloadSchema = z
  .object({
    orderId: z.uuid(),
    /**
     * When this search started, in epoch milliseconds — the search's generation.
     * A tick whose value no longer matches the order's belongs to a previous
     * search and must not act (issue #103).
     */
    searchingSinceMs: z.int().positive(),
    /**
     * The round this wave was scheduled as. Used for the job id and for the log
     * line; the round actually broadcast is taken from the clock, so a tick
     * delayed by a busy worker widens to where the search really is rather than
     * to where it was when the job was created.
     */
    round: z.int().positive().max(MAX_DISPATCH_ROUND),
  })
  .strict();

export const dispatchGiveUpPayloadSchema = z
  .object({
    orderId: z.uuid(),
    searchingSinceMs: z.int().positive(),
  })
  .strict();

export type DispatchWavePayload = z.infer<typeof dispatchWavePayloadSchema>;
export type DispatchGiveUpPayload = z.infer<typeof dispatchGiveUpPayloadSchema>;
