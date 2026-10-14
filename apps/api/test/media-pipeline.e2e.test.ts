// Tighten the retry policy before the config module is imported, as
// `deferred-work.e2e.test.ts` does: two attempts, 100 ms apart.
process.env.QUEUE_JOB_ATTEMPTS = '2';
process.env.QUEUE_JOB_BACKOFF_MS = '100';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { MediaJobTargetRegistry } from '../src/infra/media/media-job-target';
import type {
  MediaJobSource,
  MediaJobTarget,
  StoredRendition,
} from '../src/infra/media/media-job-target';
import { MediaPipelineService } from '../src/infra/media/media-pipeline.service';
import { PORTFOLIO_RENDITIONS } from '../src/infra/media/media-processor.types';
import { MediaQueueProcessor } from '../src/infra/queue/media-queue.processor';
import { NotificationsProcessor } from '../src/infra/queue/notifications.processor';
import type { MediaFailureCode } from '../src/infra/media/media-processor.types';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { solidImage } from './support/image-fixtures';

async function eventually(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ItemRecord {
  loads: number;
  completes: number;
  completed?: readonly StoredRendition[];
  failed: MediaFailureCode[];
  completeFailures: number;
  reservedKeys?: Readonly<Record<string, string>>;
}

/**
 * A stand-in for the portfolio's own target (#308), which will hold these
 * facts in `portfolio_media`. Here they are in a map, so the test reads what
 * the pipeline reported without a table that does not have its owner yet.
 */
class InMemoryTarget implements MediaJobTarget {
  readonly items = new Map<string, ItemRecord>();

  add(itemId: string, completeFailures = 0): ItemRecord {
    const record: ItemRecord = { loads: 0, completes: 0, failed: [], completeFailures };
    this.items.set(itemId, record);
    return record;
  }

  load(itemId: string): Promise<MediaJobSource | undefined> {
    const record = this.items.get(itemId);
    if (record === undefined) {
      return Promise.resolve(undefined);
    }
    record.loads += 1;
    return Promise.resolve({
      rawKey: `portfolio-incoming/${itemId}`,
      maxBytes: 5 * 1024 * 1024,
      keyPrefix: 'portfolio',
      renditions: PORTFOLIO_RENDITIONS,
      ...(record.reservedKeys === undefined ? {} : { reservedKeys: record.reservedKeys }),
    });
  }

  reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    const record = this.items.get(itemId);
    if (record !== undefined) {
      record.reservedKeys = keys;
    }
    return Promise.resolve();
  }

  complete(itemId: string, renditions: readonly StoredRendition[]) {
    const record = this.items.get(itemId);
    if (record === undefined) {
      return Promise.resolve('discarded' as const);
    }
    record.completes += 1;
    if (record.completeFailures > 0) {
      record.completeFailures -= 1;
      return Promise.reject(new Error('database unavailable'));
    }
    record.completed = renditions;
    return Promise.resolve('accepted' as const);
  }

  fail(itemId: string, code: MediaFailureCode): Promise<void> {
    this.items.get(itemId)?.failed.push(code);
    return Promise.resolve();
  }
}

/**
 * The media queue against the real local Redis (#305): a job enqueued through
 * the pipeline runs on the `media` worker, a failure the image caused is not
 * retried, a failure it did not cause is retried up to `QUEUE_JOB_ATTEMPTS`
 * and then marks the item failed, and one upload enqueued twice is one job.
 */
describe('media pipeline on the media queue (issue #305)', () => {
  let app: NestFastifyApplication;
  let pipeline: MediaPipelineService;
  let storage: StubStorageProvider;
  const target = new InMemoryTarget();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    pipeline = app.get(MediaPipelineService);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    app.get(MediaJobTargetRegistry).register('e2e-photo', target);
  });

  afterAll(async () => {
    await app.close();
  });

  it('processes an enqueued upload on the media worker', async () => {
    const itemId = uuidV7();
    const record = target.add(itemId);
    storage.putObject(`portfolio-incoming/${itemId}`, await solidImage('jpeg', 1600, 1200));

    await pipeline.enqueue('e2e-photo', itemId);

    await eventually(() => record.completed !== undefined);
    expect(record.completed?.map((r) => [r.name, r.width, r.height])).toEqual([
      ['thumb', 480, 360],
      ['display', 1440, 1080],
    ]);
    for (const rendition of record.completed ?? []) {
      expect(storage.getPublicObject(rendition.key)).toBeDefined();
    }
    expect(storage.hasObject(`portfolio-incoming/${itemId}`)).toBe(false);
  });

  it('fails an upload that is not an image once, without a retry', async () => {
    const itemId = uuidV7();
    const record = target.add(itemId);
    storage.putObject(`portfolio-incoming/${itemId}`, Buffer.from('definitely not a photo'));

    await pipeline.enqueue('e2e-photo', itemId);

    await eventually(() => record.failed.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(record.failed).toEqual(['unsupported_format']);
    expect(record.loads).toBe(1);
  });

  it('retries a failure the image did not cause up to QUEUE_JOB_ATTEMPTS, then marks the item failed', async () => {
    const itemId = uuidV7();
    // Fails every attempt: two in this file.
    const record = target.add(itemId, 10);
    storage.putObject(`portfolio-incoming/${itemId}`, await solidImage('jpeg', 400, 300));

    await pipeline.enqueue('e2e-photo', itemId);

    await eventually(() => record.failed.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(record.completes).toBe(2);
    expect(record.failed).toEqual(['processing_failed']);
    expect(storage.hasObject(`portfolio-incoming/${itemId}`)).toBe(false);
  });

  it('recovers when a retry succeeds, and the item is never failed', async () => {
    const itemId = uuidV7();
    const record = target.add(itemId, 1);
    storage.putObject(`portfolio-incoming/${itemId}`, await solidImage('jpeg', 400, 300));

    await pipeline.enqueue('e2e-photo', itemId);

    await eventually(() => record.completed !== undefined);
    expect(record.completes).toBe(2);
    expect(record.failed).toEqual([]);
  });

  it('runs one upload enqueued twice — a retried confirm — once', async () => {
    const itemId = uuidV7();
    const record = target.add(itemId);
    storage.putObject(`portfolio-incoming/${itemId}`, await solidImage('png', 200, 200));

    await Promise.all([
      pipeline.enqueue('e2e-photo', itemId),
      pipeline.enqueue('e2e-photo', itemId),
    ]);

    await eventually(() => record.completed !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(record.loads).toBe(1);
  });
});

describe('MEDIA_WORKER_MODE (issue #305)', () => {
  it('=off stops this replica consuming the media queue, and only that queue', async () => {
    process.env.MEDIA_WORKER_MODE = 'off';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await app.init();
      try {
        expect(app.get(MediaQueueProcessor).worker.isRunning()).toBe(false);
        expect(app.get(NotificationsProcessor).worker.isRunning()).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      delete process.env.MEDIA_WORKER_MODE;
    }
  });
});
