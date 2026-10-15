import { open, readFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { assertPublicKey, buildPublicUrl } from './public-url';
import { ObjectTooLargeError, PublicDeleteFailedError } from './storage.types';
import type {
  DownloadInput,
  DownloadedObject,
  PresignUploadInput,
  PresignedUrl,
  PutPublicInput,
  StorageProvider,
  StoredObjectHead,
} from './storage.types';

/**
 * S3's own ceiling on one `DeleteObjects` request
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html),
 * which R2 implements. A post holds at most a handful of renditions, so one
 * request is the normal case; the chunking is for a sweep's backlog.
 */
const DELETE_OBJECTS_BATCH_SIZE = 1000;

/** Everything this provider needs, already validated by `env.schema.ts`. */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  /** The private bucket: every client upload, read only through presigned URLs. */
  readonly bucket: string;
  /** The public bucket: server-made renditions only (ADR-0045 § 5). */
  readonly publicMediaBucket: string;
  /** The custom domain the public bucket is served at. */
  readonly mediaPublicBaseUrl: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * S3-compatible storage, built from configuration alone.
 *
 * **No provider-specific feature is used anywhere in this file**, which is
 * ADR-0005's standing constraint and the reason the provider decision stayed
 * reversible while it was open. The client is constructed from an endpoint,
 * a region, a bucket and a key pair; nothing here knows whether the other end
 * is Cloudflare R2, AWS S3 or MinIO.
 *
 * `forcePathStyle` is on because every S3-compatible endpoint accepts
 * `https://host/bucket/key`, whereas virtual-host addressing
 * (`https://bucket.host/key`) needs DNS that a self-hosted or emulated
 * endpoint usually does not have.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * A presigned PUT.
   *
   * `ContentType` is signed, so a client that uploads with a different one is
   * rejected by storage rather than by us. `ContentLength` is **not** signed,
   * and that is a deliberate consequence of
   * [ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md): signing
   * it would require the exact byte count in advance, which turns a cap into
   * an equality check and breaks every client that recompresses. The cap is
   * enforced at confirm, against `head()`, which is the fact rather than the
   * claim.
   *
   * `input.maxBytes` is therefore unused here and still part of the interface:
   * a provider that *can* bind a range into its signature should, and the day
   * TezUsta moves to one, this is the file that changes.
   */
  async presignUpload(input: PresignUploadInput): Promise<PresignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        ContentType: input.contentType,
      }),
      { expiresIn: input.ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
  }

  async presignDownload(input: { key: string; ttlSeconds: number }): Promise<PresignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
      { expiresIn: input.ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000) };
  }

  async head(key: string): Promise<StoredObjectHead | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        declaredContentType: result.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * A **ranged** GET. Twelve bytes, not five megabytes: magic-byte validation
   * only ever looks at the start of the file, and pulling the whole object
   * through the API to read its first three bytes would undo the reason the
   * bytes bypass the API in the first place.
   */
  async readPrefix(key: string, byteCount: number): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Range: `bytes=0-${String(byteCount - 1)}`,
        }),
      );
      const body = result.Body;
      if (body === undefined) {
        return undefined;
      }
      return await body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  /**
   * A streamed GET, capped twice.
   *
   * First against the `Content-Length` storage reports, so an oversized
   * object is refused before its body is read — the socket is destroyed
   * rather than drained. Then against the bytes as they arrive, because the
   * header is the provider's claim and the stream is the fact. Either way the
   * body flows through to disk a chunk at a time and is never held whole.
   *
   * A failure part-way removes the partial file. A truncated raw upload left
   * where a worker expects a complete one would be decoded as a corrupt image
   * and reported as the master's fault.
   */
  async download(input: DownloadInput): Promise<DownloadedObject | undefined> {
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    const body = result.Body;
    if (!(body instanceof Readable)) {
      // The Node runtime of the SDK always answers with a stream. Anything
      // else is a runtime this provider was not written for, and reading it
      // whole to find out would be the buffering this method exists to avoid.
      throw new Error('GetObject returned a body that is not a Node stream.');
    }

    if (result.ContentLength !== undefined && result.ContentLength > input.maxBytes) {
      body.destroy();
      throw new ObjectTooLargeError(input.maxBytes);
    }

    // Opened before a byte is streamed, so a path that already exists is
    // refused here — and so the cleanup below only ever removes a file this
    // call created. Opening inside `pipeline` would race the body: a cap or
    // socket error that arrived before the open settled would look like this
    // call's own failure, and remove someone else's file.
    let file: FileHandle;
    try {
      file = await open(input.toPath, 'wx');
    } catch (error) {
      body.destroy();
      throw error;
    }

    let written = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength;
        if (written > input.maxBytes) {
          callback(new ObjectTooLargeError(input.maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, cap, file.createWriteStream());
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(input.toPath, { force: true });
      throw error;
    }
    return { sizeBytes: written };
  }

  /**
   * A PUT to the public bucket, with the body read into memory first.
   *
   * Buffered rather than streamed because a rendition is small and bounded —
   * `sharp` wrote it to a box at most 1440 px on its long edge — and a
   * buffer is what lets the SDK retry a failed attempt and compute its
   * checksum, neither of which it can do with a stream it has already
   * consumed. The raw upload, which is not bounded that way, is the one
   * `download` streams.
   */
  async putPublic(input: PutPublicInput): Promise<void> {
    assertPublicKey(input.key);
    const body = await readFile(input.filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.publicMediaBucket,
        Key: input.key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      }),
    );
  }

  publicUrl(key: string): string {
    return buildPublicUrl(this.config.mediaPublicBaseUrl, key);
  }

  /**
   * A GET from the public bucket and a PUT into the private one. Buffered: a
   * rendition is bounded by `sharp`'s box, and `maxBytes` refuses anything
   * that is not one before it is read whole.
   */
  async copyPublicToPrivate(input: {
    publicKey: string;
    privateKey: string;
    maxBytes: number;
  }): Promise<boolean> {
    assertPublicKey(input.publicKey);
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.publicMediaBucket, Key: input.publicKey }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
    if (result.ContentLength !== undefined && result.ContentLength > input.maxBytes) {
      if (result.Body instanceof Readable) {
        result.Body.destroy();
      }
      throw new ObjectTooLargeError(input.maxBytes);
    }
    const body =
      result.Body === undefined ? new Uint8Array() : await result.Body.transformToByteArray();
    if (body.byteLength > input.maxBytes) {
      throw new ObjectTooLargeError(input.maxBytes);
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.privateKey,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: result.ContentType ?? 'application/octet-stream',
      }),
    );
    return true;
  }

  /**
   * `DeleteObjects` in `Quiet` mode, so the response lists only failures.
   *
   * S3 reports a key that did not exist as deleted, which is what makes a
   * retried sweep safe. A key it reports in `Errors` is still public, so the
   * call fails and the caller's sweep keeps the row for its next run.
   */
  async deletePublic(keys: readonly string[]): Promise<void> {
    keys.forEach(assertPublicKey);
    const unique = [...new Set(keys)];
    let failed = 0;
    for (let start = 0; start < unique.length; start += DELETE_OBJECTS_BATCH_SIZE) {
      const batch = unique.slice(start, start + DELETE_OBJECTS_BATCH_SIZE);
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.publicMediaBucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      failed += result.Errors?.length ?? 0;
    }
    if (failed > 0) {
      throw new PublicDeleteFailedError(failed);
    }
  }
}

/**
 * Absence, told apart from failure.
 *
 * S3 answers a missing object on `HeadObject` with a bodyless 404, so the SDK
 * cannot give it the `NoSuchKey` name it uses for `GetObject` — it surfaces as
 * `NotFound` with a 404 status instead. Matching on the HTTP status as well as
 * the names is what keeps this working across both commands and across
 * S3-compatible implementations that disagree about which name to use.
 *
 * Anything else rethrows. A provider outage that quietly read as "the document
 * is not there" would let a confirm decide a master had uploaded nothing, and
 * the master would be asked to do it again for no reason.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') {
    return true;
  }
  return candidate.$metadata?.httpStatusCode === 404;
}
