import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidPublicKeyError } from './public-url';
import { ObjectTooLargeError, PUBLIC_MEDIA_CACHE_CONTROL } from './storage.types';
import {
  STUB_MEDIA_PUBLIC_BASE_URL,
  StubStorageProvider,
  StubStorageProviderInProductionError,
} from './stub-storage.provider';

describe('StubStorageProvider — the media pipeline methods (issue #304)', () => {
  let storage: StubStorageProvider;
  let dir: string;

  beforeEach(async () => {
    storage = new StubStorageProvider('test', 'https://media.example.com');
    dir = await mkdtemp(path.join(tmpdir(), 'stub-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('download', () => {
    it('writes a private object to the file and reports its size', async () => {
      storage.putObject('portfolio-incoming/raw', new Uint8Array([1, 2, 3, 4]));
      const toPath = path.join(dir, 'raw');

      const result = await storage.download({ key: 'portfolio-incoming/raw', toPath, maxBytes: 4 });

      expect(result).toEqual({ sizeBytes: 4 });
      expect([...(await readFile(toPath))]).toEqual([1, 2, 3, 4]);
    });

    it('answers undefined for an object that is not there, and writes nothing', async () => {
      const toPath = path.join(dir, 'missing');

      await expect(
        storage.download({ key: 'nope', toPath, maxBytes: 10 }),
      ).resolves.toBeUndefined();
      await expect(readFile(toPath)).rejects.toThrow(/ENOENT/);
    });

    it('refuses an object one byte over the cap and leaves no file behind', async () => {
      storage.putObject('big', new Uint8Array(5));
      const toPath = path.join(dir, 'big');

      await expect(storage.download({ key: 'big', toPath, maxBytes: 4 })).rejects.toThrow(
        ObjectTooLargeError,
      );
      await expect(readFile(toPath)).rejects.toThrow(/ENOENT/);
    });

    it('refuses to overwrite a path that already exists', async () => {
      storage.putObject('k', new Uint8Array([9]));
      const toPath = path.join(dir, 'taken');
      await writeFile(toPath, 'someone else');

      await expect(storage.download({ key: 'k', toPath, maxBytes: 10 })).rejects.toThrow(/EEXIST/);
      expect(await readFile(toPath, 'utf8')).toBe('someone else');
    });

    it('reads only the private bucket — a public rendition is not downloadable', async () => {
      const source = path.join(dir, 'thumb.webp');
      await writeFile(source, 'webp');
      await storage.putPublic({
        key: 'portfolio/r/thumb.webp',
        filePath: source,
        contentType: 'image/webp',
        cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      });

      await expect(
        storage.download({
          key: 'portfolio/r/thumb.webp',
          toPath: path.join(dir, 'x'),
          maxBytes: 10,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('putPublic', () => {
    it('stores the file under the key with its type and the immutable Cache-Control', async () => {
      const source = path.join(dir, 'display.webp');
      await writeFile(source, Buffer.from([0x52, 0x49, 0x46, 0x46]));

      await storage.putPublic({
        key: 'portfolio/r/display.webp',
        filePath: source,
        contentType: 'image/webp',
        cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      });

      const stored = storage.getPublicObject('portfolio/r/display.webp');
      expect(stored?.contentType).toBe('image/webp');
      expect(stored?.cacheControl).toBe('public, max-age=31536000, immutable');
      expect([...(stored?.bytes ?? [])]).toEqual([0x52, 0x49, 0x46, 0x46]);
    });

    it('writes to the public bucket only — the private one never sees a rendition', async () => {
      const source = path.join(dir, 'f');
      await writeFile(source, 'x');

      await storage.putPublic({
        key: 'portfolio/r/thumb.webp',
        filePath: source,
        contentType: 'image/webp',
        cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      });

      expect(storage.hasObject('portfolio/r/thumb.webp')).toBe(false);
      await expect(storage.head('portfolio/r/thumb.webp')).resolves.toBeUndefined();
    });
  });

  it('refuses a rendition under a key publicUrl could not name, so nothing is public without a URL', async () => {
    const source = path.join(dir, 'f');
    await writeFile(source, 'x');

    await expect(
      storage.putPublic({
        key: '/portfolio/x.webp',
        filePath: source,
        contentType: 'image/webp',
        cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      }),
    ).rejects.toThrow(InvalidPublicKeyError);
    expect(storage.getPublicObject('/portfolio/x.webp')).toBeUndefined();
  });

  describe('publicUrl', () => {
    it('builds on the configured base URL', () => {
      expect(storage.publicUrl('portfolio/r/thumb.webp')).toBe(
        'https://media.example.com/portfolio/r/thumb.webp',
      );
    });

    it('falls back to a reserved .invalid domain when no base URL is configured', () => {
      const unconfigured = new StubStorageProvider('test');

      expect(unconfigured.publicUrl('a/b.webp')).toBe(`${STUB_MEDIA_PUBLIC_BASE_URL}/a/b.webp`);
      expect(new URL(STUB_MEDIA_PUBLIC_BASE_URL).hostname.endsWith('.invalid')).toBe(true);
    });
  });

  describe('deletePublic', () => {
    it('deletes every named rendition and is idempotent for keys already gone', async () => {
      const source = path.join(dir, 'f');
      await writeFile(source, 'x');
      for (const key of ['p/1.webp', 'p/2.webp']) {
        await storage.putPublic({
          key,
          filePath: source,
          contentType: 'image/webp',
          cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
        });
      }

      await storage.deletePublic(['p/1.webp', 'p/2.webp', 'p/never-existed.webp']);
      await storage.deletePublic(['p/1.webp']);

      expect(storage.getPublicObject('p/1.webp')).toBeUndefined();
      expect(storage.getPublicObject('p/2.webp')).toBeUndefined();
    });

    it('leaves the private bucket alone, even under the same key', async () => {
      storage.putObject('shared/key', new Uint8Array([1]));

      await storage.deletePublic(['shared/key']);

      expect(storage.hasObject('shared/key')).toBe(true);
    });
  });

  it('still refuses to construct in production', () => {
    expect(() => new StubStorageProvider('production', 'https://media.example.com')).toThrow(
      StubStorageProviderInProductionError,
    );
  });
});
