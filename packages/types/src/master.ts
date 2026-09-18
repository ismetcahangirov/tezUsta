/**
 * Where a master stands with the platform's trust gate, as the client sees it.
 *
 * The same five values the database enum carries
 * ([ADR-0023](../../../docs/decisions/ADR-0023-master-verification-policy.md)).
 * The app must branch on all five: `changes_requested` and `rejected` are
 * different screens, because one asks for an action the master can take and
 * the other must not pretend there is one.
 *
 * Kept as a string union rather than an enum — this package ships TypeScript
 * source with no build step, which holds only while every export is a type
 * ([ADR-0021](../../../docs/decisions/ADR-0021-type-only-packages-ship-source.md)).
 */
export type MasterVerificationStatus =
  'pending_verification' | 'changes_requested' | 'rejected' | 'active' | 'suspended';

/**
 * A master's role profile.
 *
 * Like `Customer`, this carries no `userId` and no phone number: identity
 * lives on the account, and this is what that person is *as a master*. One
 * human may hold both role profiles.
 */
export interface Master {
  readonly id: string;

  readonly displayName: string;

  readonly bio: string | null;

  readonly verificationStatus: MasterVerificationStatus;

  /**
   * ISO 8601 UTC, and non-null exactly when `verificationStatus` is
   * `suspended`. The two are kept in step by a database constraint rather than
   * by convention, so the app may treat either one as the answer.
   */
  readonly suspendedAt: string | null;

  /**
   * The master's own intent to receive offers. **Not** proof that they are
   * reachable: liveness is a Redis TTL refreshed by a heartbeat, and dispatch
   * requires both. A client showing this alone as "online" would tell a master
   * with a dead connection that work is on its way.
   */
  readonly isAvailable: boolean;

  /**
   * Mean rating, rounded to two decimals, or `null` when nobody has rated this
   * master yet. Null rather than `0` — no reviews is not the same as a bad
   * score, and a UI that renders them the same way punishes every new master.
   */
  readonly ratingAverage: number | null;

  readonly ratingCount: number;

  /** ISO 8601, UTC. */
  readonly createdAt: string;

  /** ISO 8601, UTC. */
  readonly updatedAt: string;
}

/**
 * One catalogue service a master offers, with the price **they** set.
 *
 * `priceMinor` is authoritative for an order, where `Service.pricing` is only
 * the catalogue's reference figure
 * ([ADR-0010](../../../docs/decisions/ADR-0010-pricing-and-commission.md)).
 */
export interface MasterService {
  readonly serviceId: string;

  /**
   * Integer **minor units** — 1500 is 15.00 AZN. Null exactly when the service
   * is inspection-priced, because that amount does not exist until a master
   * has seen the work.
   */
  readonly priceMinor: number | null;

  /**
   * Whether the master is currently offering this service. A paused offer
   * keeps its price; dispatch ignores it.
   */
  readonly isActive: boolean;

  /** ISO 8601, UTC. */
  readonly createdAt: string;

  /** ISO 8601, UTC. */
  readonly updatedAt: string;
}
