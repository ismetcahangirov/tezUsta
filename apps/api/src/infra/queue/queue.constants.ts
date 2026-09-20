/**
 * Work that is due because something happened — an order started searching,
 * a wave has to widen, a deadline has to fire.
 *
 * `backend-architecture.md` § Background jobs lists `notifications`, `sms`
 * and `payments` as well. Neither exists, and neither is created here: a
 * queue with no producer and no consumer is another key space to reason about
 * and another worker to drain on shutdown. Each arrives with its Epic
 * (ADR-0016's habit, applied to queues) — which is how `maintenance` below
 * arrived.
 */
export const DISPATCH_QUEUE = 'dispatch';

/**
 * The second queue: work that is due because time passed, not because
 * something happened.
 *
 * Separate from {@link DISPATCH_QUEUE} rather than another job name on it,
 * and the reason is contention. A dispatch tick has an SLA measured in
 * seconds — a customer is watching a spinner while it runs — and a retention
 * sweep deletes rows in bounded batches for as long as it takes. Sharing one
 * queue would put them in the same concurrency budget, so a sweep long enough
 * to fill it would delay every wave behind it. Two queues, two workers, two
 * budgets.
 *
 * It is the `maintenance` queue `docs/architecture/backend-architecture.md`
 * § Background jobs names, and it arrives with its first consumers (#57, #69,
 * #92) rather than ahead of them, which is the habit the comment above
 * describes.
 */
export const MAINTENANCE_QUEUE = 'maintenance';
