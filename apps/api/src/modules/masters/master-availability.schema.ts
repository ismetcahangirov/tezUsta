import { z } from 'zod';

/**
 * The toggle, as a body rather than as two endpoints.
 *
 * `POST /availability { isAvailable: false }` says what the master wants;
 * `POST /availability/offline` would say what the client decided to call it.
 * One idempotent statement of intent is also what a flaky connection needs:
 * repeating it is harmless, whereas repeating a toggle is not.
 */
export const setAvailabilitySchema = z.object({ isAvailable: z.boolean() }).strict();

/** The heartbeat carries nothing. Strict, so a client that invents a field hears about it. */
export const heartbeatSchema = z.object({}).strict();

export type SetAvailabilityRequest = z.infer<typeof setAvailabilitySchema>;
