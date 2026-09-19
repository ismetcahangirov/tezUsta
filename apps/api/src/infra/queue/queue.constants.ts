/**
 * The one queue this repository has so far.
 *
 * `backend-architecture.md` § Background jobs lists `notifications`, `sms`,
 * `payments` and `maintenance` as well. None of them exists, and none is
 * created here: a queue with no producer and no consumer is four more key
 * spaces to reason about and four more workers to drain on shutdown. Each
 * arrives with its Epic (ADR-0016's habit, applied to queues).
 */
export const DISPATCH_QUEUE = 'dispatch';
