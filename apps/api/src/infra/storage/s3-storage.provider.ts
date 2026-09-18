import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type {
  PresignUploadInput,
  PresignedUrl,
  StorageProvider,
  StoredObjectHead,
} from './storage.types';

/** Everything this provider needs, already validated by `env.schema.ts`. */
export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
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
