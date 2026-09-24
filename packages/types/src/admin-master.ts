import type { MasterDocumentStatus, MasterDocumentType } from './master-document.js';
import type { MasterVerificationStatus } from './master.js';

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

/** One master's file. Reading it is audited. */
export interface AdminMasterDetail extends AdminMasterSummary {
  readonly bio: string | null;
  readonly documents: readonly AdminMasterDocument[];
  /** Newest first, at most the 50 most recent entries. */
  readonly history: readonly AdminVerificationEvent[];
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
