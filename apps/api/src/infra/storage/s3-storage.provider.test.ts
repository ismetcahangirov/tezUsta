import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { InvalidPublicKeyError } from './public-url';
import { S3StorageProvider } from './s3-storage.provider';
import type { S3StorageConfig } from './s3-storage.provider';
import {
  ObjectTooLargeError,
  PUBLIC_MEDIA_CACHE_CONTROL,
  PublicDeleteFailedError,
} from './storage.types';

const CONFIG: S3StorageConfig = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'tezusta-uploads',
  publicMediaBucket: 'tezusta-media',
  mediaPublicBaseUrl: 'https://media.example.com',
  accessKeyId: 'key-id',
  secretAccessKey: 'secret',
};

type Send = (command: unknown) => Promise<unknown>;

/**
 * The SDK client with its transport replaced: every command the provider
 * builds is captured here, and answered with whatever the case sets up. The
 * provider's own code — which bucket, which key, which headers, how a body is
 * consumed — runs for real.
 */
let send: MockInstance<Send>;
let dir: string;

beforeEach(async () => {
  send = vi.spyOn(S3Client.prototype, 'send');
  dir = await mkdtemp(path.join(tmpdir(), 's3-storage-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function notFound(): Error {
  return Object.assign(new Error('NoSuchKey'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

/** A body that produces `total` bytes lazily, counting how many it was asked for. */
function lazyBody(total: number, chunkSize: number): { body: Readable; produced: () => number } {
  let produced = 0;
  const body = Readable.from(
    (function* () {
      while (produced < total) {
        const size = Math.min(chunkSize, total - produced);
        produced += size;
        yield Buffer.alloc(size, 7);
      }
    })(),
  );
  return { body, produced: () => produced };
}

describe('S3StorageProvider — presigned uploads (issue #376)', () => {
  it('signs no checksum into an upload URL, which would be the empty body's', async () => {
    const provider = new S3StorageProvider(CONFIG);

    const { url } = await provider.presignUpload({
      key: 'orders/photos/0190f6b2-7a2e-7000-8000-000000000001',
      contentType: 'image/jpeg',
      ttlSeconds: 300,
      maxBytes: 10 * 1024 * 1024,
    });

    const params = new URL(url).searchParams;
    expect([...params.keys()].filter((name) => name.toLowerCase().includes('checksum'))).toEqual(
      [],
    );
    // Still a presigned PUT for the key, with its type signed.
    expect(new URL(url).pathname).toBe(
      '/tezusta-uploads/orders/photos/0190f6b2-7a2e-7000-8000-000000000001',
    );
    expect(params.get('X-Amz-Signature')).not.toBeNull();
  });
});

describe('S3StorageProvider — the media pipeline methods (issue #304)', () => {
  describe('download', () => {
    it('GETs the key from the private bucket and streams it to the file', async () => {
      send.mockResolvedValue({ Body: Readable.from([Buffer.from('raw-bytes')]), ContentLength: 9 });
      const toPath = path.join(dir, 'raw');

      const result = await new S3StorageProvider(CONFIG).download({
        key: 'portfolio-incoming/abc',
        toPath,
        maxBytes: 100,
      });

      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect((command as GetObjectCommand).input).toEqual({
        Bucket: 'tezusta-uploads',
        Key: 'portfolio-incoming/abc',
      });
      expect(result).toEqual({ sizeBytes: 9 });
      expect(await readFile(toPath, 'utf8')).toBe('raw-bytes');
    });

    it('answers undefined for a missing object', async () => {
      send.mockRejectedValue(notFound());

      await expect(
        new S3StorageProvider(CONFIG).download({
          key: 'gone',
          toPath: path.join(dir, 'gone'),
          maxBytes: 100,
        }),
      ).resolves.toBeUndefined();
    });

    it('rethrows a failure that is not absence', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } }),
      );

      await expect(
        new S3StorageProvider(CONFIG).download({
          key: 'k',
          toPath: path.join(dir, 'k'),
          maxBytes: 100,
        }),
      ).rejects.toThrow('boom');
    });

    it('refuses on the reported size before reading a byte, and releases the body', async () => {
      const { body, produced } = lazyBody(10 * 1024 * 1024, 64 * 1024);
      send.mockResolvedValue({ Body: body, ContentLength: 10 * 1024 * 1024 });
      const toPath = path.join(dir, 'big');

      await expect(
        new S3StorageProvider(CONFIG).download({ key: 'big', toPath, maxBytes: 1024 * 1024 }),
      ).rejects.toThrow(ObjectTooLargeError);

      expect(produced()).toBe(0);
      expect(body.destroyed).toBe(true);
      await expect(readFile(toPath)).rejects.toThrow(/ENOENT/);
    });

    it('stops a body larger than its cap part-way, without reading it all, and removes the partial file', async () => {
      // No reported size — the header is a claim storage may not make — so
      // only the streaming check stands between this body and the disk.
      const total = 256 * 1024 * 1024;
      const chunk = 64 * 1024;
      const { body, produced } = lazyBody(total, chunk);
      send.mockResolvedValue({ Body: body });
      const toPath = path.join(dir, 'huge');

      await expect(
        new S3StorageProvider(CONFIG).download({ key: 'huge', toPath, maxBytes: 1024 * 1024 }),
      ).rejects.toThrow(ObjectTooLargeError);

      // A megabyte of cap, plus what the stream buffers ahead of it — nowhere
      // near the 256 MiB the body would have produced if read whole.
      expect(produced()).toBeLessThan(4 * 1024 * 1024);
      await expect(readFile(toPath)).rejects.toThrow(/ENOENT/);
    });

    it('accepts a body of exactly the cap', async () => {
      send.mockResolvedValue({ Body: Readable.from([Buffer.alloc(1024)]), ContentLength: 1024 });

      await expect(
        new S3StorageProvider(CONFIG).download({
          key: 'k',
          toPath: path.join(dir, 'exact'),
          maxBytes: 1024,
        }),
      ).resolves.toEqual({ sizeBytes: 1024 });
    });

    it('refuses to overwrite an existing path, and leaves it as it was', async () => {
      send.mockResolvedValue({ Body: Readable.from([Buffer.from('new')]), ContentLength: 3 });
      const toPath = path.join(dir, 'taken');
      await writeFile(toPath, 'someone else');

      await expect(
        new S3StorageProvider(CONFIG).download({ key: 'k', toPath, maxBytes: 100 }),
      ).rejects.toThrow(/EEXIST/);
      expect(await readFile(toPath, 'utf8')).toBe('someone else');
    });
  });

  describe('download — a path this call did not create', () => {
    it('leaves an existing file untouched when the body is over the cap and its size was not reported', async () => {
      send.mockResolvedValue({ Body: Readable.from([Buffer.alloc(2048)]) });
      const toPath = path.join(dir, 'taken-and-oversized');
      await writeFile(toPath, 'someone else');

      await expect(
        new S3StorageProvider(CONFIG).download({ key: 'k', toPath, maxBytes: 1024 }),
      ).rejects.toThrow(/EEXIST/);
      expect(await readFile(toPath, 'utf8')).toBe('someone else');
    });

    it('removes its own partial file when the body fails part-way for a reason other than the cap', async () => {
      const body = Readable.from(
        (function* () {
          yield Buffer.alloc(512, 1);
          throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        })(),
      );
      send.mockResolvedValue({ Body: body });
      const toPath = path.join(dir, 'reset');

      await expect(
        new S3StorageProvider(CONFIG).download({ key: 'k', toPath, maxBytes: 1024 * 1024 }),
      ).rejects.toThrow('socket reset');
      await expect(readFile(toPath)).rejects.toThrow(/ENOENT/);
    });
  });

  describe('public keys', () => {
    it('refuses to write or delete under a key publicUrl could not name, before calling storage', async () => {
      const filePath = path.join(dir, 'f');
      await writeFile(filePath, 'x');
      const storage = new S3StorageProvider(CONFIG);

      await expect(
        storage.putPublic({
          key: 'portfolio//thumb.webp',
          filePath,
          contentType: 'image/webp',
          cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
        }),
      ).rejects.toThrow(InvalidPublicKeyError);
      await expect(storage.deletePublic(['ok.webp', '../x'])).rejects.toThrow(
        InvalidPublicKeyError,
      );
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('putPublic', () => {
    it('PUTs the file to the public bucket with its type, length and Cache-Control', async () => {
      send.mockResolvedValue({});
      const filePath = path.join(dir, 'thumb.webp');
      await writeFile(filePath, Buffer.from('RIFFwebp'));

      await new S3StorageProvider(CONFIG).putPublic({
        key: 'portfolio/r/thumb.webp',
        filePath,
        contentType: 'image/webp',
        cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      });

      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input = (command as PutObjectCommand).input;
      expect(input).toMatchObject({
        Bucket: 'tezusta-media',
        Key: 'portfolio/r/thumb.webp',
        ContentType: 'image/webp',
        ContentLength: 8,
        CacheControl: 'public, max-age=31536000, immutable',
      });
      expect(Buffer.from(input.Body as Uint8Array).toString()).toBe('RIFFwebp');
    });
  });

  describe('putPrivate', () => {
    it('PUTs the file to the private bucket with its type and length, and no Cache-Control (#318)', async () => {
      send.mockResolvedValue({});
      const filePath = path.join(dir, 'clean.webp');
      await writeFile(filePath, Buffer.from('RIFFwebp'));

      await new S3StorageProvider(CONFIG).putPrivate({
        key: 'order-photos/r/display.webp',
        filePath,
        contentType: 'image/webp',
      });

      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input = (command as PutObjectCommand).input;
      expect(input).toMatchObject({
        Bucket: CONFIG.bucket,
        Key: 'order-photos/r/display.webp',
        ContentType: 'image/webp',
        ContentLength: 8,
      });
      expect(input.CacheControl).toBeUndefined();
      expect(Buffer.from(input.Body as Uint8Array).toString()).toBe('RIFFwebp');
    });
  });

  describe('publicUrl', () => {
    it('names the object on the custom domain, not on the S3 endpoint', () => {
      const url = new S3StorageProvider(CONFIG).publicUrl('portfolio/r/display.webp');

      expect(url).toBe('https://media.example.com/portfolio/r/display.webp');
      expect(url).not.toContain('X-Amz-');
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('deletePublic', () => {
    it('sends one quiet DeleteObjects to the public bucket, with duplicates removed', async () => {
      send.mockResolvedValue({});

      await new S3StorageProvider(CONFIG).deletePublic(['a.webp', 'b.webp', 'a.webp']);

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(DeleteObjectsCommand);
      expect((command as DeleteObjectsCommand).input).toEqual({
        Bucket: 'tezusta-media',
        Delete: { Objects: [{ Key: 'a.webp' }, { Key: 'b.webp' }], Quiet: true },
      });
    });

    it('splits a backlog into requests of at most 1000 keys', async () => {
      send.mockResolvedValue({});
      const keys = Array.from({ length: 2001 }, (_, i) => `p/${String(i)}.webp`);

      await new S3StorageProvider(CONFIG).deletePublic(keys);

      const sizes = send.mock.calls.map(
        ([command]) => (command as DeleteObjectsCommand).input.Delete?.Objects?.length,
      );
      expect(sizes).toEqual([1000, 1000, 1]);
    });

    it('sends nothing for an empty list', async () => {
      await new S3StorageProvider(CONFIG).deletePublic([]);

      expect(send).not.toHaveBeenCalled();
    });

    it('fails when storage kept any key, after trying every batch', async () => {
      send
        .mockResolvedValueOnce({ Errors: [{ Key: 'p/0.webp', Code: 'InternalError' }] })
        .mockResolvedValueOnce({});
      const keys = Array.from({ length: 1001 }, (_, i) => `p/${String(i)}.webp`);

      await expect(new S3StorageProvider(CONFIG).deletePublic(keys)).rejects.toThrow(
        PublicDeleteFailedError,
      );
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
