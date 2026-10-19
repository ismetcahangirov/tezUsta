import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { ImageRenditions } from '../src/infra/media/image-renditions';
import { MediaJobTargetRegistry } from '../src/infra/media/media-job-target';
import type {
  MediaJobSource,
  MediaJobTarget,
  StoredRendition,
} from '../src/infra/media/media-job-target';
import { MediaPipelineService } from '../src/infra/media/media-pipeline.service';
import { PORTFOLIO_RENDITIONS } from '../src/infra/media/media-processor.types';
import { MediaQueueProcessor } from '../src/infra/queue/media-queue.processor';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { geotaggedTwelveMegapixelJpeg } from './support/image-fixtures';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Benchmark for the media pipeline and portfolio feed (issue #317, EPIC 19).
 *
 * ```bash
 * docker compose up -d
 * PORTFOLIO_BENCHMARK=1 pnpm --filter api exec vitest run test/portfolio.benchmark.test.ts
 * ```
 *
 * **Opt-in, for `orders.benchmark.test.ts`'s reason.** This asserts performance
 * budgets and seeds realistic datasets (60 posts × 10 photos, a 12 MP camera
 * fixture, and bursts of uploads through BullMQ). Correctness is asserted
 * unconditionally in `portfolio.e2e.test.ts`, `media-pipeline.e2e.test.ts`,
 * and `public-profile.e2e.test.ts`.
 *
 * ## What is measured
 *
 * 1. **Image renditions:**
 *    Wall time, CPU time (user + system) and the process's peak RSS for
 *    generating both WebP renditions (`thumb` 480 px, `display` 1440 px) with
 *    metadata stripped. At 12 MP — the issue's size, and near the server's
 *    24 MP cap on what a hostile client can send — for two fixtures that
 *    bracket a real photo: a flat single-colour image (best case) and a
 *    textured one (see `texturedJpeg`). And at 2560×1920, the most the app
 *    itself uploads (ADR-0045 § 4, #319), textured. Output sizes are scaled to
 *    a full portfolio and compared with the issue's ≈135 MB estimate for 50
 *    posts.
 *
 * 2. **Queue latency under burst of 20 publishes:**
 *    Measures completion latency p50 and p95 under `concurrency: 1` vs `concurrency: 2`,
 *    on the textured fixture. This informs whether the `media` queue worker can
 *    remain in-process.
 *
 * 3. **Portfolio feed read endpoint & index usage:**
 *    `GET /masters/:id/portfolio` for a master with 60 published posts and 10
 *    items each, asserted against the standard read budget (< 200 ms p95), with
 *    an `EXPLAIN (ANALYZE, BUFFERS)` check that the planner, left to choose,
 *    picks `portfolio_posts_feed_idx` once the table holds other masters' posts.
 *
 * 4. **The API while the worker is busy (#387):**
 *    The same feed read, one request every 100 ms, while the in-process
 *    worker drains a burst of 20 publishes at concurrency 1 and 2, beside an
 *    idle baseline, with the event loop's delay over each phase. The client
 *    shares the server's process, so a stalled loop slows both sides: the
 *    figures are an upper bound on what a separate client would see.
 */

const enabled = process.env.PORTFOLIO_BENCHMARK === '1';

const IMAGE_ITERATIONS = Number(process.env.PORTFOLIO_BENCHMARK_IMAGE_ITERATIONS ?? 10);
const BURST_ITEMS = Number(process.env.PORTFOLIO_BENCHMARK_BURST_ITEMS ?? 20);
const FEED_REQUESTS = Number(process.env.PORTFOLIO_BENCHMARK_FEED_REQUESTS ?? 50);
const FEED_POST_COUNT = 60;
const FEED_ITEMS_PER_POST = 10;
const READ_P95_BUDGET_MS = 200;
// How often the read under the worker's load starts a request (#387).
const READ_INTERVAL_MS = 100;
// Both renditions of one app-sized photo: 1.14 s p95 measured (#317), plus
// room for the run-to-run noise seen on the development laptop.
const APP_SIZED_RENDER_P95_BUDGET_MS = 1500;
// Other masters' posts, so the planner meets a table where an index matters.
const BACKGROUND_MASTERS = 500;
// The issue's estimate is for 50 posts; ADR-0045's ceiling is 60 posts × 10 photos.
const ISSUE_ESTIMATE_PHOTOS = 50 * 10;
const MAX_PORTFOLIO_PHOTOS = 60 * 10;

/**
 * A JPEG with detail at every scale; at 4000×3000 it is about 4 MB at q90,
 * the size of a phone camera's output. The flat fixture in `image-fixtures.ts`
 * decodes and encodes far faster than a photo and compresses to almost
 * nothing, so it understates both the worker's CPU and the storage. Summed
 * noise octaves compress worse than a real scene, so this one errs the other
 * way: its rendition sizes are an upper bound, not a typical photo.
 */
async function texturedJpeg(width: number, height: number): Promise<Buffer> {
  const octaves: readonly (readonly [divisor: number, sigma: number])[] = [
    [64, 40],
    [16, 25],
    [4, 15],
    [1, 8],
  ];
  const layers = await Promise.all(
    octaves.map(([divisor, sigma]) =>
      sharp({
        create: {
          width: Math.round(width / divisor),
          height: Math.round(height / divisor),
          channels: 3,
          // Required by sharp's types; libvips ignores it when `noise` is set.
          background: '#808080',
          noise: { type: 'gaussian', mean: 128, sigma },
        },
      })
        .resize(width, height, { kernel: 'cubic' })
        .raw()
        .toBuffer(),
    ),
  );
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) {
    let value = 128;
    for (const layer of layers) {
      value += layer[i]! - 128;
    }
    pixels[i] = Math.max(0, Math.min(255, value));
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
}

async function eventually(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface BenchmarkItem {
  readonly id: string;
  readonly enqueuedAt: number;
  completedAt?: number;
  renditions?: readonly StoredRendition[];
}

class BenchmarkMediaTarget implements MediaJobTarget {
  readonly items = new Map<string, BenchmarkItem>();

  registerItem(id: string, enqueuedAt: number): void {
    this.items.set(id, { id, enqueuedAt });
  }

  load(itemId: string): Promise<MediaJobSource | undefined> {
    const item = this.items.get(itemId);
    if (item === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      rawKey: `portfolio-incoming/${itemId}`,
      maxBytes: 15 * 1024 * 1024,
      keyPrefix: 'portfolio',
      renditions: PORTFOLIO_RENDITIONS,
    });
  }

  reserveKeys(): Promise<void> {
    return Promise.resolve();
  }

  complete(itemId: string, renditions: readonly StoredRendition[]): Promise<'accepted'> {
    const item = this.items.get(itemId);
    if (item !== undefined) {
      item.completedAt = performance.now();
      item.renditions = renditions;
    }
    return Promise.resolve('accepted');
  }

  fail(): Promise<void> {
    return Promise.resolve();
  }

  allCompleted(expectedCount: number): boolean {
    let completed = 0;
    for (const item of this.items.values()) {
      if (item.completedAt !== undefined) {
        completed += 1;
      }
    }
    return completed >= expectedCount;
  }
}

describe.runIf(enabled)('portfolio & media pipeline benchmark (issue #317)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let baseUrl: string;
  let pool: Pool;
  let redis: Redis;
  let storage: StubStorageProvider;
  let pipeline: MediaPipelineService;
  let mediaProcessor: MediaQueueProcessor;
  let sessionsService: SessionsService;
  let db: Database;
  let benchmarkTarget: BenchmarkMediaTarget;

  let masterId: string;
  let customerToken: string;
  let serviceId: string;
  let flat12MpJpeg: Buffer;
  // Built on first use, after the flat fixture is measured, so that its own
  // allocation does not sit in the flat run's peak RSS.
  let textured12MpJpeg: Promise<Buffer> | undefined;
  const texturedFixture = () => (textured12MpJpeg ??= texturedJpeg(4000, 3000));

  const savedEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string): void {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  /**
   * A customer whose order grants them the master's profile (ADR-0045 § 2):
   * one the master is on now, or one completed an hour ago, inside the review
   * window. A master holds one active order at a time, so every customer
   * after the first is a recent one. Returns their access token.
   */
  async function seedCustomerWithOrder(
    phoneE164: string,
    status: 'ACCEPTED' | 'COMPLETED',
  ): Promise<string> {
    const createdCustomerUser = await app.get(UsersRepository).create({
      phoneE164,
      roles: ['customer'],
    });
    const customerUserId = createdCustomerUser.user.id;
    const customerId = randomUUID();
    const addressId = randomUUID();

    await pool.query(
      `insert into customers (id, user_id, display_name) values ($1, $2, 'Müştəri Əli')`,
      [customerId, customerUserId],
    );
    await pool.query(
      `insert into addresses (id, customer_id, formatted_address, position, is_default)
       values ($1, $2, 'Bakı şəhəri, Nizami küç. 45', ST_SetSRID(ST_MakePoint(49.85, 40.38), 4326), true)`,
      [addressId, customerId],
    );
    const { rows: orderRows } = await pool.query<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status, description, price_minor, idempotency_key, accepted_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Mətbəx krantının təmiri', 4000, gen_random_uuid(), now())
       returning id`,
      [customerId, addressId, serviceId, masterId, status],
    );
    if (status === 'COMPLETED') {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
         values (gen_random_uuid(), $1, 'IN_PROGRESS', 'COMPLETED', 'system', now() - interval '1 hour')`,
        [orderRows[0]?.id],
      );
    }

    const session = await sessionsService.startSession({ userId: customerUserId });
    return session.accessToken;
  }

  beforeAll(async () => {
    // The flat 12 MP fixture; the textured one is built on first use.
    flat12MpJpeg = await geotaggedTwelveMegapixelJpeg();

    const env = parseEnv(process.env);
    database = await createThrowawayDatabase(env.database.url);
    await runMigrations(database.url);
    await runSeed(database.url);

    setEnv('DATABASE_URL', database.url);
    setEnv('MEDIA_WORKER_MODE', 'in-process');
    setEnv('MEDIA_WORKER_CONCURRENCY', '1');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    redis = app.get<Redis>(REDIS_CLIENT);
    db = app.get<Database>(DATABASE_CONNECTION);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pipeline = app.get(MediaPipelineService);
    mediaProcessor = app.get(MediaQueueProcessor);
    sessionsService = app.get(SessionsService);

    benchmarkTarget = new BenchmarkMediaTarget();
    app.get(MediaJobTargetRegistry).register('bench-photo', benchmarkTarget);

    // Seed base service
    const { rows: serviceRows } = await pool.query<{ id: string }>(
      'select id from services where is_active limit 1',
    );
    const foundServiceId = serviceRows[0]?.id;
    if (foundServiceId === undefined) {
      throw new Error('Expected at least one active service in seed');
    }
    serviceId = foundServiceId;

    // Seed master with 60 published posts and 10 ready photos each
    masterId = randomUUID();
    const usersRepo = app.get(UsersRepository);
    const createdMasterUser = await usersRepo.create({
      phoneE164: '+994770000001',
      roles: ['master'],
    });
    const masterUserId = createdMasterUser.user.id;

    await pool.query(
      `insert into masters (
         id, user_id, display_name, verification_status, bio, rating_sum, rating_count,
         avatar_thumb_key, avatar_display_key
       )
       values ($1, $2, 'Usta Elnur', 'active', 'Santexnik ustası, 10 il təcrübə', 48, 10, 'avatars/1/thumb.webp', 'avatars/1/display.webp')`,
      [masterId, masterUserId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 4000, true)`,
      [masterId, serviceId],
    );

    // Bulk seed 60 published posts
    const postIds = Array.from({ length: FEED_POST_COUNT }, () => randomUUID());
    await pool.query(
      `insert into portfolio_posts (id, master_id, caption, service_id, status, media_count, published_at, created_at, updated_at)
       select
         p.id,
         $1,
         'Təmir və quraşdırma işi #' || p.idx::text,
         $2,
         'published',
         $3,
         now() - make_interval(hours => (100 - p.idx)),
         now() - make_interval(hours => (100 - p.idx)),
         now() - make_interval(hours => (100 - p.idx))
       from unnest($4::uuid[], $5::int[]) as p(id, idx)`,
      [masterId, serviceId, FEED_ITEMS_PER_POST, postIds, postIds.map((_, i) => i + 1)],
    );

    // Bulk seed 10 ready media items per post (600 items)
    await pool.query(
      `insert into portfolio_media (
         id, post_id, position, raw_storage_key, declared_content_type, verified_content_type,
         raw_size_bytes, presign_expires_at, status, thumb_key, display_key, width, height, bytes_total
       )
       select
         gen_random_uuid(),
         p.id,
         pos,
         'portfolio-incoming/' || p.id::text || '-' || pos::text,
         'image/jpeg',
         'image/jpeg',
         250000,
         now() + interval '1 hour',
         'ready',
         'portfolio/' || p.id::text || '/' || pos::text || '/thumb.webp',
         'portfolio/' || p.id::text || '/' || pos::text || '/display.webp',
         1440,
         1080,
         185000
       from unnest($1::uuid[]) as p(id)
       cross join generate_series(0, $2) as pos`,
      [postIds, FEED_ITEMS_PER_POST - 1],
    );

    // Other masters, 60 published posts each. With only one master's rows the
    // whole table fits in two pages and a sequential scan is the right plan.
    await pool.query(
      `with u as (
         insert into users (id, phone_e164)
         select gen_random_uuid(), '+99455' || lpad(g::text, 7, '0')
           from generate_series(1, $1::int) as g
         returning id
       ), m as (
         insert into masters (id, user_id, display_name, verification_status)
         select gen_random_uuid(), u.id, 'Usta', 'active' from u
         returning id
       )
       insert into portfolio_posts (id, master_id, caption, service_id, status, media_count, published_at, created_at, updated_at)
       select gen_random_uuid(), m.id, null, $2, 'published', 0,
              now() - make_interval(hours => g), now() - make_interval(hours => g), now()
         from m cross join generate_series(1, $3::int) as g`,
      [BACKGROUND_MASTERS, serviceId, FEED_POST_COUNT],
    );
    await pool.query('analyze portfolio_posts');

    customerToken = await seedCustomerWithOrder('+994770000002', 'ACCEPTED');

    // Print environment banner
    const cpus = os.cpus();
    const [{ rows: pgRows }, redisInfo] = await Promise.all([
      pool.query<{ version: string }>('select version()'),
      redis.info('server'),
    ]);
    const redisVersion = /redis_version:([^\r\n]+)/.exec(redisInfo)?.[1] ?? 'unknown';

    process.stdout.write(
      [
        '',
        '================================================================================',
        'portfolio & media pipeline benchmark environment',
        `  node:             ${process.version}`,
        `  platform:         ${os.platform()} ${os.arch()}`,
        `  cpus:             ${String(cpus.length)}x ${cpus[0]?.model ?? 'unknown'}`,
        `  total memory:     ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
        `  postgres:         ${pgRows[0]?.version ?? 'unknown'}`,
        `  redis:            ${redisVersion}`,
        '================================================================================',
        '',
      ].join('\n'),
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    for (const [name, val] of savedEnv) {
      if (val === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = val;
      }
    }
    await database.drop();
  }, 120_000);

  async function measureRenditions(label: string, input: Buffer): Promise<{ wallP95: number }> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bench-12mp-'));
    try {
      const inputPath = path.join(tempDir, 'input.jpg');
      await writeFile(inputPath, input);

      const processor = new ImageRenditions({ maxInputPixels: 24_000_000 });
      const baselinePeakRssMb = (process.resourceUsage().maxRSS / 1024).toFixed(1);

      // Warmup
      await processor.renderImage({
        inputPath,
        outputDir: tempDir,
        renditions: PORTFOLIO_RENDITIONS,
      });

      const wallSamples: number[] = [];
      const cpuSamples: number[] = [];
      let lastOutputs: readonly { name: string; bytes: number; width: number; height: number }[] =
        [];

      for (let i = 0; i < IMAGE_ITERATIONS; i += 1) {
        const startCpu = process.cpuUsage();
        const startWall = performance.now();

        const rendered = await processor.renderImage({
          inputPath,
          outputDir: tempDir,
          renditions: PORTFOLIO_RENDITIONS,
        });

        const wallDuration = performance.now() - startWall;
        const cpuDiff = process.cpuUsage(startCpu);

        wallSamples.push(wallDuration);
        cpuSamples.push((cpuDiff.user + cpuDiff.system) / 1000);
        lastOutputs = rendered;
      }

      wallSamples.sort((a, b) => a - b);
      cpuSamples.sort((a, b) => a - b);

      const wallP50 = percentile(wallSamples, 0.5);
      const wallP95 = percentile(wallSamples, 0.95);
      const cpuP50 = percentile(cpuSamples, 0.5);
      const cpuP95 = percentile(cpuSamples, 0.95);
      // The OS's high-water mark for the whole process so far, in KiB: a true
      // peak, where sampling before and after a render would miss libvips'
      // buffers allocated and freed inside it.
      const peakRssMb = (process.resourceUsage().maxRSS / 1024).toFixed(1);

      const thumbRendition = lastOutputs.find((r) => r.name === 'thumb');
      const displayRendition = lastOutputs.find((r) => r.name === 'display');

      expect(thumbRendition).toBeDefined();
      expect(displayRendition).toBeDefined();

      const photoTotalBytes = (thumbRendition?.bytes ?? 0) + (displayRendition?.bytes ?? 0);
      const toMb = (photos: number) => ((photoTotalBytes * photos) / (1024 * 1024)).toFixed(1);

      // Verify metadata stripping on generated rendition
      const meta = await sharp(path.join(tempDir, 'display.webp')).metadata();
      expect(meta.exif).toBeUndefined();

      process.stdout.write(
        [
          `JPEG image renditions, ${label} fixture (thumb 480 px + display 1440 px WebP)`,
          `  iterations:              ${IMAGE_ITERATIONS}`,
          `  input size:              ${(input.length / 1024).toFixed(1)} KB`,
          `  wall time p50 / p95:     ${wallP50.toFixed(1)} ms / ${wallP95.toFixed(1)} ms`,
          `  cpu time p50 / p95:      ${cpuP50.toFixed(1)} ms / ${cpuP95.toFixed(1)} ms`,
          `  process peak RSS:        ${baselinePeakRssMb} MB before renders, ${peakRssMb} MB after`,
          `  rendition output thumb:  ${thumbRendition?.width ?? 0}x${thumbRendition?.height ?? 0}, ${(
            (thumbRendition?.bytes ?? 0) / 1024
          ).toFixed(1)} KB`,
          `  rendition output display:${displayRendition?.width ?? 0}x${displayRendition?.height ?? 0}, ${(
            (displayRendition?.bytes ?? 0) / 1024
          ).toFixed(1)} KB`,
          `  total per photo:         ${(photoTotalBytes / 1024).toFixed(1)} KB`,
          `  storage, ${String(ISSUE_ESTIMATE_PHOTOS)} photos:    ${toMb(ISSUE_ESTIMATE_PHOTOS)} MB (issue estimate: ≈135 MB for 50 posts)`,
          `  storage, ${String(MAX_PORTFOLIO_PHOTOS)} photos:    ${toMb(MAX_PORTFOLIO_PHOTOS)} MB (ADR-0045 ceiling: 60 posts × 10)`,
          '',
        ].join('\n'),
      );

      return { wallP95 };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it('measures image renditions (wall time, CPU, RSS, storage)', async () => {
    // 12 MP is recorded as the worst case, not budgeted: the app never sends it.
    await measureRenditions('12 MP flat', flat12MpJpeg);
    await measureRenditions('12 MP textured', await texturedFixture());
    const appSized = await measureRenditions('2560x1920 textured', await texturedJpeg(2560, 1920));

    expect(appSized.wallP95).toBeLessThan(APP_SIZED_RENDER_P95_BUDGET_MS);
  }, 180_000);

  it('measures media queue latency under a burst of 20 publishes at concurrency 1 vs concurrency 2', async () => {
    const input = await texturedFixture();
    // --- Run with concurrency 1 ---
    mediaProcessor.worker.concurrency = 1;
    const c1ItemIds = Array.from({ length: BURST_ITEMS }, () => randomUUID());
    for (const id of c1ItemIds) {
      storage.putObject(`portfolio-incoming/${id}`, input);
      benchmarkTarget.registerItem(id, performance.now());
    }

    const c1StartedAt = performance.now();
    await Promise.all(c1ItemIds.map((id) => pipeline.enqueue('bench-photo', id)));
    await eventually(() => benchmarkTarget.allCompleted(BURST_ITEMS), 60_000);
    const c1WallClockMs = performance.now() - c1StartedAt;

    const c1Latencies = c1ItemIds
      .map((id) => {
        const item = benchmarkTarget.items.get(id);
        return (item?.completedAt ?? 0) - (item?.enqueuedAt ?? 0);
      })
      .sort((a, b) => a - b);

    const c1P50 = percentile(c1Latencies, 0.5);
    const c1P95 = percentile(c1Latencies, 0.95);
    const c1Rps = (BURST_ITEMS / (c1WallClockMs / 1000)).toFixed(2);

    // --- Run with concurrency 2 ---
    mediaProcessor.worker.concurrency = 2;
    const c2ItemIds = Array.from({ length: BURST_ITEMS }, () => randomUUID());
    for (const id of c2ItemIds) {
      storage.putObject(`portfolio-incoming/${id}`, input);
      benchmarkTarget.registerItem(id, performance.now());
    }

    const c2StartedAt = performance.now();
    await Promise.all(c2ItemIds.map((id) => pipeline.enqueue('bench-photo', id)));
    await eventually(() => benchmarkTarget.allCompleted(BURST_ITEMS * 2), 60_000);
    const c2WallClockMs = performance.now() - c2StartedAt;

    const c2Latencies = c2ItemIds
      .map((id) => {
        const item = benchmarkTarget.items.get(id);
        return (item?.completedAt ?? 0) - (item?.enqueuedAt ?? 0);
      })
      .sort((a, b) => a - b);

    const c2P50 = percentile(c2Latencies, 0.5);
    const c2P95 = percentile(c2Latencies, 0.95);
    const c2Rps = (BURST_ITEMS / (c2WallClockMs / 1000)).toFixed(2);

    process.stdout.write(
      [
        'media queue burst performance (20x 12 MP textured publishes)',
        `  concurrency 1:`,
        `    wall clock:            ${(c1WallClockMs / 1000).toFixed(2)} s`,
        `    throughput:            ${c1Rps} items/s`,
        `    latency p50:           ${c1P50.toFixed(1)} ms`,
        `    latency p95:           ${c1P95.toFixed(1)} ms`,
        `  concurrency 2:`,
        `    wall clock:            ${(c2WallClockMs / 1000).toFixed(2)} s`,
        `    throughput:            ${c2Rps} items/s`,
        `    latency p50:           ${c2P50.toFixed(1)} ms`,
        `    latency p95:           ${c2P95.toFixed(1)} ms`,
        `  speedup (wall clock):    ${(c1WallClockMs / c2WallClockMs).toFixed(2)}x`,
        '',
      ].join('\n'),
    );

    // Concurrency 2 must process the batch faster than concurrency 1
    expect(c2WallClockMs).toBeLessThan(c1WallClockMs);
  }, 90_000);

  it('measures portfolio feed read latency and verifies partial index scan', async () => {
    // Warmup
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${baseUrl}/masters/${masterId}/portfolio?limit=30`, {
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(res.status).toBe(200);
    }

    // Benchmark requests
    const samples: number[] = [];
    for (let i = 0; i < FEED_REQUESTS; i += 1) {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/masters/${masterId}/portfolio?limit=30`, {
        headers: { authorization: `Bearer ${customerToken}` },
      });
      const duration = performance.now() - start;
      expect(res.status).toBe(200);
      samples.push(duration);
    }

    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const p99 = percentile(samples, 0.99);
    const max = samples[samples.length - 1] ?? 0;

    process.stdout.write(
      [
        `portfolio feed read (GET /masters/:id/portfolio) — ${FEED_POST_COUNT} posts, ${FEED_ITEMS_PER_POST} photos each`,
        `  requests:                ${FEED_REQUESTS}`,
        `  p50:                     ${p50.toFixed(2)} ms`,
        `  p95:                     ${p95.toFixed(2)} ms`,
        `  p99:                     ${p99.toFixed(2)} ms`,
        `  max:                     ${max.toFixed(2)} ms`,
        `  budget:                  < ${READ_P95_BUDGET_MS} ms p95`,
        '',
      ].join('\n'),
    );

    // The first page of `PublicProfileRepository.listFeed`, with the planner
    // free to choose: the table also holds BACKGROUND_MASTERS other masters'
    // posts, analysed, so a sequential scan is no longer the cheap plan.
    const planResult = await db.execute<{ 'QUERY PLAN': string }>(sql`
      explain (analyze, buffers)
      select * from portfolio_posts
       where master_id = ${masterId}
         and status = 'published'
         and removed_at is null
       order by published_at desc, id desc
       limit 30
    `);
    const planLines = planResult.rows.map((r) => r['QUERY PLAN']).join('\n');

    process.stdout.write(['feed query plan:', planLines, ''].join('\n'));

    expect(planLines).toContain('portfolio_posts_feed_idx');
    expect(p95).toBeLessThan(READ_P95_BUDGET_MS);
  }, 60_000);

  it('measures feed read latency and event loop delay while the worker drains a burst (#387)', async () => {
    const input = await texturedFixture();

    // `profile-read` allows 300 reads per account and 600 per IP an hour, and
    // every request here comes from loopback. Reads are paced and shared
    // between customers so that the production limits stay as they are and
    // are never what answers: about 420 reads in all, ~110 per customer.
    const readers = [
      customerToken,
      ...(await Promise.all(
        ['+994770000011', '+994770000012', '+994770000013'].map((phone) =>
          seedCustomerWithOrder(phone, 'COMPLETED'),
        ),
      )),
    ];
    let readsSent = 0;

    async function readFeed(): Promise<number> {
      const token = readers[readsSent % readers.length]!;
      readsSent += 1;
      const start = performance.now();
      const res = await fetch(`${baseUrl}/masters/${masterId}/portfolio?limit=30`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await res.arrayBuffer();
      const duration = performance.now() - start;
      expect(res.status).toBe(200);
      return duration;
    }

    interface Phase {
      readonly label: string;
      readonly samples: readonly number[];
      readonly loopP50Ms: number;
      readonly loopP99Ms: number;
      readonly loopMaxMs: number;
    }

    // One read started every READ_INTERVAL_MS until `done`, never two at once,
    // with the event loop's delay sampled throughout. Paced rather than
    // back to back, so the client's own work does not crowd the loop it is
    // measuring.
    async function phase(label: string, done: (reads: number) => boolean): Promise<Phase> {
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const samples: number[] = [];
      let nextAt = performance.now();
      while (!done(samples.length)) {
        const wait = nextAt - performance.now();
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        nextAt += READ_INTERVAL_MS;
        samples.push(await readFeed());
      }
      loop.disable();
      samples.sort((a, b) => a - b);
      return {
        label,
        samples,
        loopP50Ms: loop.percentile(50) / 1e6,
        loopP99Ms: loop.percentile(99) / 1e6,
        loopMaxMs: loop.max / 1e6,
      };
    }

    async function underBurst(concurrency: number): Promise<Phase> {
      mediaProcessor.worker.concurrency = concurrency;
      const ids = Array.from({ length: BURST_ITEMS }, () => randomUUID());
      for (const id of ids) {
        storage.putObject(`portfolio-incoming/${id}`, input);
        benchmarkTarget.registerItem(id, performance.now());
      }
      await Promise.all(ids.map((id) => pipeline.enqueue('bench-photo', id)));
      return phase(`burst, concurrency ${String(concurrency)}`, () =>
        ids.every((id) => benchmarkTarget.items.get(id)?.completedAt !== undefined),
      );
    }

    // Warmup
    for (let i = 0; i < 5; i += 1) {
      await readFeed();
    }

    const idle = await phase('idle', (reads) => reads >= FEED_REQUESTS);
    const c1 = await underBurst(1);
    const c2 = await underBurst(2);

    const row = (p: Phase) =>
      [
        `  ${p.label}:`,
        `    feed requests:         ${String(p.samples.length)}`,
        `    feed p50 / p95 / max:  ${percentile(p.samples, 0.5).toFixed(2)} / ${percentile(
          p.samples,
          0.95,
        ).toFixed(2)} / ${(p.samples[p.samples.length - 1] ?? 0).toFixed(2)} ms`,
        `    loop delay p50 / p99 / max: ${p.loopP50Ms.toFixed(2)} / ${p.loopP99Ms.toFixed(
          2,
        )} / ${p.loopMaxMs.toFixed(2)} ms`,
      ].join('\n');

    process.stdout.write(
      [
        'feed read while the media worker drains a burst of 20 (12 MP textured)',
        row(idle),
        row(c1),
        row(c2),
        `  budget:                  < ${String(READ_P95_BUDGET_MS)} ms p95, at concurrency 1`,
        '',
      ].join('\n'),
    );

    // Enough reads inside the burst for its p95 to mean something.
    expect(c1.samples.length).toBeGreaterThanOrEqual(FEED_REQUESTS);
    expect(percentile(c1.samples, 0.95)).toBeLessThan(READ_P95_BUDGET_MS);
  }, 120_000);
});
