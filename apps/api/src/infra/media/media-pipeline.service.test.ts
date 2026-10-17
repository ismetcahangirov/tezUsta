import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  geotaggedTwelveMegapixelJpeg,
  pixelBombPng,
  solidImage,
} from '../../../test/support/image-fixtures';
import { DeferredJobHandlerRegistry } from '../queue/deferred-job-handler.registry';
import type { MediaWorkService } from '../queue/media-work.service';
import { PermanentJobError } from '../queue/queue.types';
import { StubStorageProvider } from '../storage/stub-storage.provider';
import { ImageRenditions } from './image-renditions';
import { MediaJobTargetRegistry } from './media-job-target';
import type { MediaJobSource, MediaJobTarget, StoredRendition } from './media-job-target';
import { MediaPipelineService, PROCESS_MEDIA_JOB } from './media-pipeline.service';
import { PORTFOLIO_RENDITIONS } from './media-processor.types';
import type { MediaFailureCode } from './media-processor.types';

const ITEM_ID = '01a13a7a-7091-72b8-9e67-9a46dbd71511';
const RAW_KEY = 'portfolio-incoming/raw-1';

/** A target that records what the pipeline told it. */
class RecordingTarget implements MediaJobTarget {
  source: MediaJobSource | undefined = {
    rawKey: RAW_KEY,
    maxBytes: 5 * 1024 * 1024,
    keyPrefix: 'portfolio',
    renditions: PORTFOLIO_RENDITIONS,
  };
  outcome: 'accepted' | 'discarded' = 'accepted';
  completeFailures = 0;
  readonly completed: (readonly StoredRendition[])[] = [];
  readonly failed: MediaFailureCode[] = [];
  readonly reservations: Readonly<Record<string, string>>[] = [];

  load(): Promise<MediaJobSource | undefined> {
    if (this.source === undefined) {
      return Promise.resolve(undefined);
    }
    const reservedKeys = this.reservations.at(-1);
    return Promise.resolve(
      reservedKeys === undefined ? this.source : { ...this.source, reservedKeys },
    );
  }

  reserveKeys(_itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    this.reservations.push(keys);
    return Promise.resolve();
  }

  complete(_itemId: string, renditions: readonly StoredRendition[]) {
    this.completed.push(renditions);
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(this.outcome);
  }

  fail(_itemId: string, code: MediaFailureCode): Promise<void> {
    this.failed.push(code);
    return Promise.resolve();
  }
}

let storage: StubStorageProvider;
let target: RecordingTarget;
let pipeline: MediaPipelineService;
let tempRoot: string;

beforeEach(async () => {
  storage = new StubStorageProvider('test', 'https://media.example.com');
  target = new RecordingTarget();
  const targets = new MediaJobTargetRegistry();
  targets.register('portfolio-photo', target);
  tempRoot = await mkdtemp(path.join(tmpdir(), 'media-pipeline-'));
  pipeline = new MediaPipelineService(
    storage,
    new ImageRenditions({ maxInputPixels: 24_000_000 }),
    targets,
    new DeferredJobHandlerRegistry(),
    {} as MediaWorkService,
    tempRoot,
  );
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const payload = { purpose: 'portfolio-photo', itemId: ITEM_ID };
const LAST = { attempt: 3, maxAttempts: 3 };
const FIRST = { attempt: 1, maxAttempts: 3 };

async function tempEntries(): Promise<string[]> {
  return readdir(tempRoot);
}

describe('MediaPipelineService (issue #305)', () => {
  it('registers its job on the media queue’s handler registry', () => {
    const handlers = new DeferredJobHandlerRegistry();
    const registered = new MediaPipelineService(
      storage,
      new ImageRenditions({ maxInputPixels: 24_000_000 }),
      new MediaJobTargetRegistry(),
      handlers,
      {} as MediaWorkService,
    );

    registered.onModuleInit();

    expect(handlers.names()).toContain(PROCESS_MEDIA_JOB);
  });

  it('downloads, renders, publishes both renditions, reports them, deletes the raw upload and its temp dir', async () => {
    storage.putObject(RAW_KEY, await solidImage('jpeg', 2000, 1500));

    await pipeline.run(payload, FIRST);

    expect(target.failed).toEqual([]);
    const [stored] = target.completed;
    expect(stored?.map((r) => r.name)).toEqual(['thumb', 'display']);
    expect(stored?.[0]).toMatchObject({ width: 480, height: 360 });
    expect(stored?.[1]).toMatchObject({ width: 1440, height: 1080 });
    for (const rendition of stored ?? []) {
      // `portfolio/<random>/<name>.webp`: no master id, no post id (ADR-0045 § 5).
      expect(rendition.key).toMatch(/^portfolio\/[0-9a-f]{32}\/(thumb|display)\.webp$/);
      expect(rendition.key).not.toContain(ITEM_ID);
      const object = storage.getPublicObject(rendition.key);
      expect(object?.contentType).toBe('image/webp');
      expect(object?.cacheControl).toBe('public, max-age=31536000, immutable');
      expect(object?.bytes.byteLength).toBe(rendition.bytes);
    }
    expect(new Set(stored?.map((r) => r.key.split('/')[1])).size).toBe(1);
    expect(storage.hasObject(RAW_KEY)).toBe(false);
    expect(await tempEntries()).toEqual([]);
  });

  it('writes a private photo’s rendition back to the private bucket, without its metadata (#318)', async () => {
    target.source = {
      rawKey: RAW_KEY,
      maxBytes: 20 * 1024 * 1024,
      keyPrefix: 'order-photos',
      renditions: [{ name: 'display', longEdge: 1440, quality: 80 }],
      destination: 'private',
    };
    storage.putObject(RAW_KEY, await geotaggedTwelveMegapixelJpeg());

    await pipeline.run(payload, FIRST);

    const [stored] = target.completed;
    const display = stored?.[0];
    expect(display?.key).toMatch(/^order-photos\/[0-9a-f]{32}\/display\.webp$/);
    expect(storage.getPublicObject(display?.key ?? '')).toBeUndefined();
    const object = storage.getObject(display?.key ?? '');
    expect(object?.contentType).toBe('image/webp');
    const meta = await sharp(object?.bytes).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1440, height: 1080 });
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    // The raw upload, GPS and all, is gone.
    expect(storage.hasObject(RAW_KEY)).toBe(false);
  });

  it('deletes a discarded private rendition from the private bucket (#318)', async () => {
    target.source = {
      rawKey: RAW_KEY,
      maxBytes: 5 * 1024 * 1024,
      keyPrefix: 'order-photos',
      renditions: [{ name: 'display', longEdge: 1440, quality: 80 }],
      destination: 'private',
    };
    target.outcome = 'discarded';
    storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

    await pipeline.run(payload, FIRST);

    const key = target.completed[0]?.[0]?.key ?? '';
    expect(key).not.toBe('');
    expect(storage.hasObject(key)).toBe(false);
  });

  it('gives every upload its own random key segment', async () => {
    storage.putObject(RAW_KEY, await solidImage('png', 100, 100));
    await pipeline.run(payload, FIRST);
    // A second upload: a fresh item, with nothing reserved yet.
    target.reservations.length = 0;
    storage.putObject(RAW_KEY, await solidImage('png', 100, 100));
    await pipeline.run(payload, FIRST);

    const [first, second] = target.completed.map((r) => r[0]?.key.split('/')[1]);
    expect(first).not.toBe(second);
  });

  it('does nothing when the owner has nothing to process — deleted, or already done', async () => {
    target.source = undefined;
    storage.putObject(RAW_KEY, await solidImage('jpeg', 100, 100));

    await pipeline.run(payload, FIRST);

    expect(target.completed).toEqual([]);
    expect(target.failed).toEqual([]);
    expect(storage.hasObject(RAW_KEY)).toBe(true);
    expect(await tempEntries()).toEqual([]);
  });

  it('deletes the renditions again when the owner discards them — the post was deleted mid-processing', async () => {
    target.outcome = 'discarded';
    storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

    await pipeline.run(payload, FIRST);

    expect(target.completed).toHaveLength(1);
    for (const rendition of target.completed[0] ?? []) {
      expect(storage.getPublicObject(rendition.key)).toBeUndefined();
    }
    expect(storage.hasObject(RAW_KEY)).toBe(false);
  });

  describe('a failure the image caused', () => {
    it.each([
      ['a corrupt file', () => Promise.resolve(Buffer.from('not an image')), 'unsupported_format'],
      [
        'a truncated JPEG',
        async () => (await solidImage('jpeg', 800, 600)).subarray(0, 2000),
        'undecodable',
      ],
      ['a decompression bomb', () => Promise.resolve(pixelBombPng()), 'too_many_pixels'],
    ] as const)(
      'marks %s failed on the first attempt, with no retry, and deletes the raw upload',
      async (_label, bytes, code) => {
        storage.putObject(RAW_KEY, await bytes());

        await expect(pipeline.run(payload, FIRST)).rejects.toThrow(PermanentJobError);

        expect(target.failed).toEqual([code]);
        expect(target.completed).toEqual([]);
        expect(storage.hasObject(RAW_KEY)).toBe(false);
        expect(await tempEntries()).toEqual([]);
      },
    );

    it('marks an upload over its byte cap too_large', async () => {
      target.source = { ...(target.source as MediaJobSource), maxBytes: 100 };
      storage.putObject(RAW_KEY, await solidImage('jpeg', 400, 300));

      await expect(pipeline.run(payload, FIRST)).rejects.toThrow(PermanentJobError);

      expect(target.failed).toEqual(['too_large']);
      expect(await tempEntries()).toEqual([]);
    });

    it('marks an upload whose raw object is gone missing', async () => {
      await expect(pipeline.run(payload, FIRST)).rejects.toThrow(PermanentJobError);

      expect(target.failed).toEqual(['missing']);
    });
  });

  describe('a failure the image did not cause', () => {
    it('is retried: the item is not failed, the raw upload is kept, and the retry writes over the same reserved keys', async () => {
      target.completeFailures = 1;
      storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

      await expect(pipeline.run(payload, FIRST)).rejects.toThrow('database unavailable');

      expect(target.failed).toEqual([]);
      expect(storage.hasObject(RAW_KEY)).toBe(true);
      expect(await tempEntries()).toEqual([]);
      // `complete` may have committed before it threw, so a ready item could
      // already point at these: they are not deleted.
      expect(target.completed).toHaveLength(1);
      for (const rendition of target.completed[0] ?? []) {
        expect(storage.getPublicObject(rendition.key)).toBeDefined();
      }

      await pipeline.run(payload, { attempt: 2, maxAttempts: 3 });

      expect(target.completed).toHaveLength(2);
      expect(target.reservations).toHaveLength(1);
      expect(target.completed[1]?.map((r) => r.key)).toEqual(
        target.completed[0]?.map((r) => r.key),
      );
      expect(target.failed).toEqual([]);
    });

    it('reserves the keys on the item before any rendition is written under them', async () => {
      let publicObjectsAtReserve = -1;
      const reserve = target.reserveKeys.bind(target);
      target.reserveKeys = (itemId, keys) => {
        publicObjectsAtReserve = Object.values(keys).filter(
          (key) => storage.getPublicObject(key) !== undefined,
        ).length;
        return reserve(itemId, keys);
      };
      storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

      await pipeline.run(payload, FIRST);

      expect(publicObjectsAtReserve).toBe(0);
      expect(Object.keys(target.reservations[0] ?? {})).toEqual(['thumb', 'display']);
      expect(target.completed[0]?.map((r) => r.key)).toEqual(
        Object.values(target.reservations[0] ?? {}),
      );
    });

    it('a write that fails before complete is retried over the same keys, and on the last attempt its renditions are deleted', async () => {
      storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));
      const put = storage.putPublic.bind(storage);
      let puts = 0;
      storage.putPublic = (input) => {
        puts += 1;
        return puts === 2 ? Promise.reject(new Error('storage unavailable')) : put(input);
      };

      await expect(pipeline.run(payload, LAST)).rejects.toThrow('storage unavailable');

      expect(target.completed).toEqual([]);
      expect(target.failed).toEqual(['processing_failed']);
      for (const key of Object.values(target.reservations[0] ?? {})) {
        expect(storage.getPublicObject(key)).toBeUndefined();
      }
    });

    it('on the last attempt, marks the item processing_failed instead of leaving it processing', async () => {
      target.completeFailures = 1;
      storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

      await expect(pipeline.run(payload, LAST)).rejects.toThrow('database unavailable');

      expect(target.failed).toEqual(['processing_failed']);
      expect(storage.hasObject(RAW_KEY)).toBe(false);
      expect(await tempEntries()).toEqual([]);
    });

    it('treats a run without a queue as its only attempt', async () => {
      target.completeFailures = 1;
      storage.putObject(RAW_KEY, await solidImage('jpeg', 600, 400));

      await expect(pipeline.run(payload)).rejects.toThrow('database unavailable');

      expect(target.failed).toEqual(['processing_failed']);
    });
  });

  it('refuses a malformed payload or an unregistered purpose without a retry', async () => {
    await expect(
      pipeline.run({ purpose: 'portfolio-photo', itemId: 'nope' }, FIRST),
    ).rejects.toThrow(PermanentJobError);
    await expect(pipeline.run({ purpose: 'avatar', itemId: ITEM_ID }, FIRST)).rejects.toThrow(
      PermanentJobError,
    );
  });
});
