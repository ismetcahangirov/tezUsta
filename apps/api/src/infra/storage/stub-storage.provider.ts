import { Logger } from '@nestjs/common';

import type {
  PresignUploadInput,
  PresignedUrl,
  StorageProvider,
  StoredObjectHead,
} from './storage.types';

/**
 * Thrown when the stub provider is constructed in production.
 *
 * The same mechanism, and the same reasoning, as
 * `StubSmsSender`: a runtime `if` would leave the service booting, accepting
 * uploads, telling masters their documents were received, and holding them in
 * a process's heap until the next deploy. Refusing to construct turns a
 * missing storage configuration into a deployment that fails immediately and
 * names the variable.
 */
export class StubStorageProviderInProductionError extends Error {
  constructor() {
    super(
      'STORAGE_PROVIDER=stub cannot be used in production: it keeps uploaded objects in memory, ' +
        'so every verification document would be lost on restart and none would ever be ' +
        'reviewable. Configure S3-compatible storage (ADR-0005, ADR-0024).',
    );
    this.name = 'StubStorageProviderInProductionError';
    Object.setPrototypeOf(this, StubStorageProviderInProductionError.prototype);
  }
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly declaredContentType: string | null;
}

/**
 * The development and test provider: an in-memory bucket.
 *
 * It exists so the whole upload path — presign, confirm, size cap, magic-byte
 * validation, ownership, audit trail — is exercisable and testable without a
 * storage account, and without standing up an S3 server in CI. That is the
 * same trade the SMS stub makes, for the same reason.
 *
 * **What it deliberately does not prove** is the SigV4 signature itself. It
 * returns a `stub://` URL that no HTTP client can use, because the client-side
 * PUT is, by definition, not this codebase's code. A test drives the upload
 * leg through {@link putObject}. Anything asserting that a *real* presigned URL
 * is accepted by a *real* S3 implementation needs a real provider, and the
 * honest place to say so is here rather than in a test that pretends
 * otherwise.
 */
export class StubStorageProvider implements StorageProvider {
  private readonly logger = new Logger(StubStorageProvider.name);
  private readonly objects = new Map<string, StoredObject>();

  constructor(private readonly nodeEnv: 'development' | 'test' | 'production') {
    if (nodeEnv === 'production') {
      throw new StubStorageProviderInProductionError();
    }
  }

  presignUpload(input: PresignUploadInput): Promise<PresignedUrl> {
    if (this.nodeEnv === 'development') {
      this.logger.warn(
        `[STUB STORAGE] upload presigned for ${input.key} (${input.contentType}, cap ${String(input.maxBytes)} bytes)`,
      );
    }
    return Promise.resolve({
      url: `stub://upload/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    });
  }

  presignDownload(input: { key: string; ttlSeconds: number }): Promise<PresignedUrl> {
    return Promise.resolve({
      url: `stub://download/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    });
  }

  head(key: string): Promise<StoredObjectHead | undefined> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      sizeBytes: stored.bytes.byteLength,
      declaredContentType: stored.declaredContentType,
    });
  }

  readPrefix(key: string, byteCount: number): Promise<Uint8Array | undefined> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(stored.bytes.slice(0, byteCount));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  /**
   * Stands in for the client's PUT to the presigned URL.
   *
   * Not part of {@link StorageProvider}: no production code may write bytes
   * through the API, which is the whole point of presigning
   * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)). A test reaches
   * for this by resolving the concrete class from the Nest container, which is
   * possible only because the configured provider is the stub.
   *
   * It accepts **any** size and **any** declared type on purpose. A fake that
   * enforced the rules would make every test green regardless of whether the
   * service enforces them, which is the failure mode this whole file is
   * otherwise designed to avoid.
   */
  putObject(key: string, bytes: Uint8Array, declaredContentType: string | null = null): void {
    this.objects.set(key, { bytes, declaredContentType });
  }

  /** Test helper: whether an object survived a confirm that rejected it. */
  hasObject(key: string): boolean {
    return this.objects.has(key);
  }
}
