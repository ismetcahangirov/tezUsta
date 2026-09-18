/**
 * Where one problem photo stands (issue #83), built on the same mechanism
 * `MasterDocumentStatus` uses — with one extra state, because a photo is
 * issued to a **customer** before any order exists, and only becomes part of
 * an order's record once explicitly attached:
 *
 * - `awaiting_upload` — presigned, nothing behind the key yet.
 * - `confirmed` — a real, sized, sniffed image, not yet on any order.
 * - `attached` — bound to exactly one order, permanently.
 */
export type OrderPhotoStatus = 'awaiting_upload' | 'confirmed' | 'attached';

/**
 * One problem photo, as the owning customer or the assigned master sees it.
 *
 * **There is no storage key here, and no URL** — same reasoning as
 * `MasterDocument`: the key is a server-side capability, and a URL is always
 * fetched on demand from a `.../download` route rather than embedded in a
 * list a client might cache.
 */
export interface OrderPhoto {
  readonly id: string;
  /** Null until the photo is attached to an order. */
  readonly orderId: string | null;
  readonly status: OrderPhotoStatus;
  /** The real object size, verified at confirm. Null before that. */
  readonly sizeBytes: number | null;
  /** ISO 8601 UTC — when the upload was confirmed. Null before that. */
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A presigned PUT, and everything the client needs to use it. */
export interface OrderPhotoUpload {
  /** Confirm with this after the PUT succeeds. */
  readonly photoId: string;
  readonly uploadUrl: string;
  /** ISO 8601 UTC. The URL stops working here; ADR-0005 caps it at 5 minutes. */
  readonly expiresAt: string;
  /** The `Content-Type` the URL was signed for. Sending another one fails. */
  readonly contentType: string;
  /**
   * The cap this upload must respect. A courtesy, not the enforcement — the
   * server re-reads the real size at confirm (ADR-0024).
   */
  readonly maxBytes: number;
}

/** A short-lived read URL for one photo. */
export interface OrderPhotoDownload {
  readonly url: string;
  /** ISO 8601, UTC. */
  readonly expiresAt: string;
}
