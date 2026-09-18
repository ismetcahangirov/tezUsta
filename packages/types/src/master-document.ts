/**
 * The three files a master submits, fixed by
 * [ADR-0023](../../../docs/decisions/ADR-0023-master-verification-policy.md).
 */
export type MasterDocumentType = 'id_card_front' | 'id_card_back' | 'selfie_with_id';

/**
 * Where one file stands.
 *
 * `awaiting_upload` is a row that exists before any bytes do — the server's
 * record that this key was issued to this master for this document, which is
 * what makes a presigned URL single-use (S3 has no native mechanism for that).
 * A client normally never sees it: the presign response carries the id, and
 * the next thing that happens is a confirm.
 */
export type MasterDocumentStatus = 'awaiting_upload' | 'pending_review' | 'accepted' | 'rejected';

/**
 * One verification document, as the owning master sees it.
 *
 * **There is no storage key here, and no URL.** The key is a server-side
 * identifier and handing it to a client would invite a client to construct
 * paths from it; a URL is always short-lived and is fetched on demand from
 * `GET /masters/me/documents/:id/download` rather than embedded in a list that
 * a client might cache.
 */
export interface MasterDocument {
  readonly id: string;
  readonly documentType: MasterDocumentType;
  readonly status: MasterDocumentStatus;
  /** The real object size, verified at confirm. Null before that. */
  readonly sizeBytes: number | null;
  /** ISO 8601 UTC — when the upload was confirmed. Null before that. */
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A presigned PUT, and everything the client needs to use it. */
export interface MasterDocumentUpload {
  /** Confirm with this after the PUT succeeds. */
  readonly documentId: string;
  readonly uploadUrl: string;
  /** ISO 8601 UTC. The URL stops working here; ADR-0005 caps it at 5 minutes. */
  readonly expiresAt: string;
  /** The `Content-Type` the URL was signed for. Sending another one fails. */
  readonly contentType: string;
  /**
   * The cap this upload must respect.
   *
   * Sent so the app can refuse an oversized file before spending a master's
   * mobile data on it. **It is not the enforcement** — the server re-reads the
   * real size at confirm and rejects there, because a client-side check is a
   * courtesy and a server-side one is a control.
   */
  readonly maxBytes: number;
}

/** A short-lived read URL for one document. */
export interface MasterDocumentDownload {
  readonly url: string;
  /** ISO 8601, UTC. */
  readonly expiresAt: string;
}

/**
 * What the master still has to do before review can start.
 *
 * `missingDocumentTypes` is why this is a shape rather than a boolean: the app
 * has to tell a master *which* file is missing, and "verification incomplete"
 * is not something anybody can act on.
 */
export interface MasterVerificationSubmission {
  readonly submitted: boolean;
  readonly missingDocumentTypes: readonly MasterDocumentType[];
}
