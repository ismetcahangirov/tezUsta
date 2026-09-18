import type { MasterVerificationStatus } from '@tezusta/types';

import type {
  MasterDocumentStatusName,
  MasterDocumentTypeName,
  MasterVerificationActorKindName,
} from '../../infra/database/schema/master-verification';

/**
 * The admin surface's response contracts.
 *
 * **Deliberately here and not in `packages/types`.** That package is for a
 * contract crossing the HTTP boundary *to a second workspace*, and a package
 * is created on the second consumer rather than speculatively
 * ([ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md)). `apps/admin`
 * does not exist yet — it is EPIC 13 — so today these types have exactly one
 * consumer, which is the file that produces them. They move when the web app
 * that reads them arrives, and moving them is then a file move rather than a
 * redesign, because nothing here names a Nest, Fastify or Drizzle type.
 *
 * The status unions are the exception and are imported rather than restated:
 * `MasterVerificationStatus` already crosses the boundary to `apps/mobile`, so
 * restating it here would be two sources of truth for one enum.
 */
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
  readonly actorKind: MasterVerificationActorKindName;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** One document, as the reviewer sees it. */
export interface AdminMasterDocument {
  readonly id: string;
  readonly documentType: MasterDocumentTypeName;
  readonly status: MasterDocumentStatusName;
  readonly sizeBytes: number | null;
  /**
   * What the server concluded the bytes actually were. The master's own view
   * does not carry this; a reviewer deciding whether to trust a file has a
   * legitimate reason to.
   */
  readonly verifiedContentType: string | null;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
}

export interface AdminMasterDetail extends AdminMasterSummary {
  readonly bio: string | null;
  readonly documents: readonly AdminMasterDocument[];
  readonly history: readonly AdminVerificationEvent[];
}
