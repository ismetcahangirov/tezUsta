/**
 * The object-storage boundary
 * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)).
 *
 * ADR-0005 fixes the architecture — S3-compatible storage, written directly by
 * the client through a presigned URL, bytes never passing through the API —
 * and [ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md) fixes
 * the mechanism: a presigned **PUT**, because the provider is Cloudflare R2 and
 * R2 does not implement the POST form-policy that would otherwise bind a size
 * cap into the signature.
 *
 * Nothing in this file names a vendor or carries a vendor type. That is what
 * keeps the eventual move to `packages/config` (ADR-0016) a file move, and it
 * is also what makes the cap enforceable: every method here is expressed in
 * terms of a key and a byte count, so the service above can hold the same rule
 * whichever implementation is configured.
 */

/** A short-lived URL the client uses directly, and when it stops working. */
export interface PresignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * What storage says about an object that is already there.
 *
 * `sizeBytes` is **the fact** — the number of bytes the object actually
 * occupies — as opposed to the `Content-Length` a client declared before
 * uploading, which is a claim. ADR-0024 makes the difference load-bearing: the
 * size cap is enforced against this, at confirm time, because R2 cannot bind
 * it into the signature.
 */
export interface StoredObjectHead {
  readonly sizeBytes: number;
  /** As stored. A client assertion, never trusted — see `sniffContentType`. */
  readonly declaredContentType: string | null;
}

export interface PresignUploadInput {
  /** Server-generated. Never a client filename — that is path traversal. */
  readonly key: string;
  readonly contentType: string;
  readonly ttlSeconds: number;
  /**
   * The cap this upload is supposed to respect.
   *
   * Passed down rather than kept above, because an implementation that *can*
   * bind it into the signature should. R2 cannot, so the S3 provider signs
   * `Content-Length` where the provider honours it and the confirm step is
   * what actually enforces the number either way (ADR-0024).
   */
  readonly maxBytes: number;
}

/**
 * The operations TezUsta needs from object storage, and no others.
 *
 * Deliberately not a general-purpose S3 facade. Every method here exists
 * because a documented control requires it:
 *
 * - `presignUpload` / `presignDownload` — bytes never pass through the API.
 * - `head` — the size cap, enforced against reality at confirm (ADR-0024).
 * - `readPrefix` — magic-byte validation. A declared `Content-Type` is a
 *   client assertion, and the only way to check it is to look at the bytes.
 * - `delete` — an object that fails validation must not survive the request
 *   that rejected it.
 */
export interface StorageProvider {
  presignUpload(input: PresignUploadInput): Promise<PresignedUrl>;

  presignDownload(input: { key: string; ttlSeconds: number }): Promise<PresignedUrl>;

  /** `undefined` when the object is not there — never an exception for absence. */
  head(key: string): Promise<StoredObjectHead | undefined>;

  /**
   * The first `byteCount` bytes, for magic-byte validation. Ranged, so a
   * 5 MB image costs twelve bytes to check rather than five megabytes.
   */
  readPrefix(key: string, byteCount: number): Promise<Uint8Array | undefined>;

  /** Idempotent: deleting an object that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * DI token for {@link StorageProvider}. An interface cannot be injected by its
 * own type (mirrors `infra/sms/sms-sender.types.ts`).
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
