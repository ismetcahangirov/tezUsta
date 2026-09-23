import type { Address } from './address.js';
import type { OrderStatus } from './order.js';

/**
 * The job a master is on right now, as `GET /masters/me/jobs/current` returns
 * it (issue #198).
 *
 * **An explicit field list, and the absences are deliberate.** No
 * `customerId`, no customer name and no phone number: a master needs where to
 * go and what is wrong there, and nothing that identifies the person beyond
 * the address the job is at. A column added to `orders` later reaches a master
 * only by being added here on purpose.
 *
 * `status` is always one of the four engaged statuses — `ACCEPTED`,
 * `MASTER_ON_THE_WAY`, `MASTER_ARRIVED` or `IN_PROGRESS` — because the moment
 * an order leaves them it stops being this master's job, and the read answers
 * `null` instead.
 */
export interface MasterJob {
  readonly orderId: string;
  /** The offer the master accepted, which the address read is keyed by. */
  readonly offerId: string;
  readonly status: OrderStatus;
  readonly serviceId: string;
  readonly description: string;
  /** Minor units, frozen at accept (ADR-0013). Null for a quote-on-site service. */
  readonly priceMinor: number | null;
  readonly acceptedAt: string;
  /** Exact, because the master is going there. Readable only while engaged. */
  readonly address: Address;
}

/**
 * The response wraps the job rather than answering `null` or 404.
 *
 * "No job right now" is the ordinary state of an online master, not an error,
 * and a bare `null` body is one some HTTP clients read as "no content". An
 * object with a nullable field says the same thing in a shape nobody misreads.
 */
export interface CurrentMasterJob {
  readonly job: MasterJob | null;
}
