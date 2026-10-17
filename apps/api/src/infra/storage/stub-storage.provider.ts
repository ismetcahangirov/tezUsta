import { readFile, writeFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';

import { assertPublicKey, buildPublicUrl } from './public-url';
import { ObjectTooLargeError } from './storage.types';
import type {
  DownloadInput,
  DownloadedObject,
  PresignUploadInput,
  PresignedUrl,
  PutPrivateInput,
  PutPublicInput,
  StorageProvider,
  StoredObjectHead,
} from './storage.types';

/**
 * Where the stub says public media lives when `MEDIA_PUBLIC_BASE_URL` is not
 * set. `.invalid` is reserved by RFC 2606 and never resolves, so a URL built
 * on it is plainly not a real object, and it still parses as an `https` URL
 * wherever a response schema checks one.
 */
export const STUB_MEDIA_PUBLIC_BASE_URL = 'https://media.stub.invalid';

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

/** A public object as it was written: the headers are what a test asserts on. */
export interface StubPublicObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
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
  /** The second bucket (ADR-0045 § 5), kept apart as the real one is. */
  private readonly publicObjects = new Map<string, StubPublicObject>();

  constructor(
    private readonly nodeEnv: 'development' | 'test' | 'production',
    private readonly mediaPublicBaseUrl: string = STUB_MEDIA_PUBLIC_BASE_URL,
  ) {
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
   * The cap is checked before anything is written, so an oversized object
   * leaves no file behind — the outcome the S3 provider guarantees by
   * removing its partial file. `wx` refuses an existing path, as there.
   */
  async download(input: DownloadInput): Promise<DownloadedObject | undefined> {
    const stored = this.objects.get(input.key);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.bytes.byteLength > input.maxBytes) {
      throw new ObjectTooLargeError(input.maxBytes);
    }
    await writeFile(input.toPath, stored.bytes, { flag: 'wx' });
    return { sizeBytes: stored.bytes.byteLength };
  }

  async putPublic(input: PutPublicInput): Promise<void> {
    assertPublicKey(input.key);
    const bytes = await readFile(input.filePath);
    this.publicObjects.set(input.key, {
      bytes: new Uint8Array(bytes),
      contentType: input.contentType,
      cacheControl: input.cacheControl,
    });
  }

  async putPrivate(input: PutPrivateInput): Promise<void> {
    const bytes = await readFile(input.filePath);
    this.objects.set(input.key, {
      bytes: new Uint8Array(bytes),
      declaredContentType: input.contentType,
    });
  }

  publicUrl(key: string): string {
    return buildPublicUrl(this.mediaPublicBaseUrl, key);
  }

  copyPublicToPrivate(input: {
    publicKey: string;
    privateKey: string;
    maxBytes: number;
  }): Promise<boolean> {
    assertPublicKey(input.publicKey);
    const source = this.publicObjects.get(input.publicKey);
    if (source === undefined) {
      return Promise.resolve(false);
    }
    if (source.bytes.byteLength > input.maxBytes) {
      return Promise.reject(new ObjectTooLargeError(input.maxBytes));
    }
    this.objects.set(input.privateKey, {
      bytes: source.bytes,
      declaredContentType: source.contentType,
    });
    return Promise.resolve(true);
  }

  deletePublic(keys: readonly string[]): Promise<void> {
    keys.forEach(assertPublicKey);
    for (const key of keys) {
      this.publicObjects.delete(key);
    }
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

  /** Test helper: a private object's bytes and type, or `undefined`. */
  getObject(key: string): { bytes: Uint8Array; contentType: string | null } | undefined {
    const stored = this.objects.get(key);
    return stored === undefined
      ? undefined
      : { bytes: stored.bytes, contentType: stored.declaredContentType };
  }

  /** Test helper: a rendition as `putPublic` wrote it, or `undefined`. */
  getPublicObject(key: string): StubPublicObject | undefined {
    return this.publicObjects.get(key);
  }
}
