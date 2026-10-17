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
 * The `Cache-Control` every public rendition is written with
 * ([ADR-0045](docs/decisions/ADR-0045-master-portfolio.md) § 5).
 *
 * A rendition never changes under its key — a new photo gets a new random
 * key — so the CDN and `expo-image` may keep it for a year, and the only
 * time it leaves a cache early is a purge on deletion.
 */
export const PUBLIC_MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface DownloadInput {
  /** A key in the private bucket. */
  readonly key: string;
  /**
   * Where to write it. Created exclusively, so a path that already exists —
   * a stale file, or a link planted in a shared temp directory — is refused
   * rather than overwritten or followed.
   */
  readonly toPath: string;
  /**
   * The most this download may write. Checked against the stored size before
   * a byte is read and again while streaming, so an object larger than this
   * never reaches the disk whole and never sits in memory at all.
   */
  readonly maxBytes: number;
}

export interface DownloadedObject {
  /** The bytes actually written to `toPath`. */
  readonly sizeBytes: number;
}

export interface PutPublicInput {
  /** Server-generated and random (ADR-0045 § 5): `portfolio/<random>/thumb.webp`. */
  readonly key: string;
  /** A file the server produced. Never a path a client named. */
  readonly filePath: string;
  readonly contentType: string;
  /** {@link PUBLIC_MEDIA_CACHE_CONTROL} for every rendition. */
  readonly cacheControl: string;
}

export interface PutPrivateInput {
  /** Server-generated and random, as every private key is. */
  readonly key: string;
  /** A file the server produced. Never a path a client named. */
  readonly filePath: string;
  readonly contentType: string;
}

/**
 * Thrown by `download` when the object is larger than the caller allowed.
 *
 * Neither the key nor the actual size is in the message: the size is only
 * known when storage reported it up front, and a message that sometimes
 * carries it is one a log reader cannot rely on.
 */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The stored object is larger than the ${String(maxBytes)}-byte cap for this download.`);
    this.name = 'ObjectTooLargeError';
    Object.setPrototypeOf(this, ObjectTooLargeError.prototype);
  }
}

/**
 * Thrown by `deletePublic` when storage reported keys it could not delete.
 *
 * A key that was already gone is not one of them — S3 reports it as deleted —
 * so this means an object is still public that was meant not to be, and the
 * caller's sweep must try again rather than purge the CDN and move on.
 */
export class PublicDeleteFailedError extends Error {
  constructor(readonly failedCount: number) {
    super(`Storage could not delete ${String(failedCount)} public object(s).`);
    this.name = 'PublicDeleteFailedError';
    Object.setPrototypeOf(this, PublicDeleteFailedError.prototype);
  }
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
 * - `download` / `putPublic` / `publicUrl` / `deletePublic` — the media
 *   pipeline (ADR-0045 § 5): a worker reads a raw upload from the private
 *   bucket, writes server-made renditions to the public one, names them by
 *   URL, and deletes them again when their post goes.
 * - `putPrivate` — the same pipeline for a photo that stays private (#318):
 *   an order or conversation photo, re-encoded without its metadata, is
 *   written back to the private bucket. Still never bytes a client sent.
 *
 * There are two buckets. The private one holds everything a client uploads
 * and is read only through presigned URLs; ADR-0024 rests on it staying
 * private. The public one holds only renditions the server made, and is
 * served from a custom domain without a signature. Every method names its
 * bucket by its name: the four `*Public` methods touch the public one, and
 * nothing else does.
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

  /**
   * Streams a private object to a file. `undefined` when the object is not
   * there; {@link ObjectTooLargeError} when it is larger than `maxBytes`, in
   * which case nothing is left at `toPath`.
   */
  download(input: DownloadInput): Promise<DownloadedObject | undefined>;

  /** Writes a server-made file to the public bucket, replacing any object under the key. */
  putPublic(input: PutPublicInput): Promise<void>;

  /** Writes a server-made file to the private bucket, replacing any object under the key. */
  putPrivate(input: PutPrivateInput): Promise<void>;

  /**
   * The unsigned URL a public object is served at. Pure: it neither checks
   * that the object exists nor talks to storage, so a response can name
   * every rendition it carries without a round trip each.
   */
  publicUrl(key: string): string;

  /**
   * Deletes public objects, batched. Idempotent: a key that is not there is
   * not an error. {@link PublicDeleteFailedError} when storage kept any.
   */
  deletePublic(keys: readonly string[]): Promise<void>;

  /**
   * Copies a public object into the private bucket under `privateKey` — a
   * removed post's renditions kept as evidence (ADR-0045 § 6). Read and
   * written by the server rather than a `CopyObject` between buckets, which
   * R2 is not documented to support. `false` when the public object is not
   * there; it throws when it is larger than `maxBytes`.
   */
  copyPublicToPrivate(input: {
    publicKey: string;
    privateKey: string;
    maxBytes: number;
  }): Promise<boolean>;
}

/**
 * DI token for {@link StorageProvider}. An interface cannot be injected by its
 * own type (mirrors `infra/sms/sms-sender.types.ts`).
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
