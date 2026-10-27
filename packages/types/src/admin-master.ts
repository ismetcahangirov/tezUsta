import type { MasterDocumentStatus, MasterDocumentType } from './master-document.js';
import type { MasterVerificationStatus } from './master.js';
import type { SubscriptionStatus } from './subscription.js';

/**
 * The admin panel's view of master verification (`/admin/masters`, issue
 * #39; ADR-0023). These are the shapes `apps/api` serves from
 * `admin-masters.types.ts`; they are here because `apps/admin` is their
 * second consumer (ADR-0016), and the API's own copy moves to import them in
 * its own commit.
 */

/** Who moved a master's verification status. `system` is a machine decision. */
export type AdminVerificationActorKind = 'master' | 'admin' | 'system';

/** One row of the review queue, and the answer to every review action. */
export interface AdminMasterSummary {
  readonly id: string;
  readonly displayName: string;
  readonly verificationStatus: MasterVerificationStatus;
  /** ISO 8601 UTC, non-null exactly when the status is `suspended`. */
  readonly suspendedAt: string | null;
  readonly isAvailable: boolean;
  readonly ratingCount: number;
  readonly createdAt: string;
  /** Where the master's subscription stands; `null` before approval starts a trial (#324). */
  readonly subscriptionStatus: SubscriptionStatus | null;
}

/** One entry in a master's verification trail. */
export interface AdminVerificationEvent {
  readonly fromStatus: MasterVerificationStatus;
  readonly toStatus: MasterVerificationStatus;
  readonly actorKind: AdminVerificationActorKind;
  /** Written by the admin and shown to the master (ADR-0023). */
  readonly reason: string | null;
  readonly createdAt: string;
}

/** One verification document, as a reviewer sees it. No storage key, no URL. */
export interface AdminMasterDocument {
  readonly id: string;
  readonly documentType: MasterDocumentType;
  readonly status: MasterDocumentStatus;
  readonly sizeBytes: number | null;
  /** What the server concluded the bytes actually were. */
  readonly verifiedContentType: string | null;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
}

/** A service a master offers, with its catalogue name — the reviewer's view. */
export interface AdminMasterService {
  readonly serviceId: string;
  /** In Azerbaijani, the catalogue's fallback language. */
  readonly serviceName: string;
  /** Minor units; null for an inspection-priced service. */
  readonly priceMinor: number | null;
  /** Whether the master is offering it now; a paused offer keeps its price. */
  readonly isActive: boolean;
}

/**
 * How the master has kept their jobs
 * ([ADR-0068](../../../docs/decisions/ADR-0068-cancellation-rules.md) §§ 4
 * and 6). For an admin only: nothing happens automatically, and no customer
 * ever sees it.
 */
export interface AdminMasterJobRecord {
  /** Orders the master accepted and then handed back to the search. */
  readonly handBacks: number;
  /** Jobs the master reached after the arrival time they were promised. */
  readonly lateArrivals: number;
}

/** One master's file. Reading it is audited. */
export interface AdminMasterDetail extends AdminMasterSummary {
  readonly bio: string | null;
  /**
   * The avatar's 512 px rendition, a public URL, or `null` (#309). Shown so a
   * moderator can see what they would remove (ADR-0045 § 8, #312).
   */
  readonly avatarUrl: string | null;
  /** Every service the master has set up, paused ones included. */
  readonly services: readonly AdminMasterService[];
  readonly documents: readonly AdminMasterDocument[];
  /** Newest first, at most the 50 most recent entries. */
  readonly history: readonly AdminVerificationEvent[];
  readonly jobRecord: AdminMasterJobRecord;
}

/** `GET /admin/masters/:id/documents/:documentId/download` — audited, short-lived. */
export interface AdminMasterDocumentDownload {
  readonly url: string;
  readonly expiresAt: string;
}

/** `reject`, `request-more` and `suspend` take one; `verify` and `reinstate` take `{}`. */
export interface AdminMasterReasonRequest {
  readonly reason: string;
}
