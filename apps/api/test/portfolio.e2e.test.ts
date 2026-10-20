import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  CursorPage,
  OwnPortfolioMedia,
  OwnPortfolioPost,
  PortfolioMediaUpload,
} from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { loadAppConfig } from '../src/infra/config/load-app-config';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MediaPipelineService, PROCESS_MEDIA_JOB } from '../src/infra/media/media-pipeline.service';
import { MEDIA_QUEUE } from '../src/infra/queue/queue.constants';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { createRateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { PortfolioMediaTarget } from '../src/modules/portfolio/portfolio-media.target';
import { PortfolioRepository } from '../src/modules/portfolio/portfolio.repository';
import { PORTFOLIO_PHOTO_PURPOSE } from '../src/modules/portfolio/portfolio.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { solidImage } from './support/image-fixtures';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/** Small, so the post limit is reachable in a test; the shipped default is 60. */
const MAX_POSTS = 3;
const MAX_ITEMS = 10;
/** Per master: room for every flow below, and a limit the 429 test can reach. */
const UPLOADS_PER_USER = 15;
/** Small, so the oversize test writes 2 MiB rather than 15. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Every test here renders photos with `sharp`, which is CPU work: a few
 * hundred milliseconds a photo alone, several times that under the full
 * suite. A ceiling of its own rather than the global 5 s (#356's case (b)).
 */
const IMAGE_TEST_TIMEOUT_MS = 30_000;

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

interface Party {
  readonly userId: string;
  readonly token: string;
}

interface Master extends Party {
  readonly masterId: string;
}

/**
 * The master's own portfolio over HTTP (#308).
 *
 * The `media` worker is off in this file (`MEDIA_WORKER_MODE=off`): each
 * test runs a photo's job itself, through the real pipeline — `sharp`, the
 * stub storage, the portfolio's own target — at the moment the test needs it.
 * That is what makes the races below deterministic to set up. The queue
 * transport itself is #305's `media-pipeline.e2e.test.ts`; here, a confirm is
 * shown to enqueue its job, and the job is then run by hand.
 */
describe('master portfolio API (issue #308)', { timeout: IMAGE_TEST_TIMEOUT_MS }, () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let storage: StubStorageProvider;
  let pipeline: MediaPipelineService;
  let mediaQueue: Queue;
  let serviceId: string;
  let otherServiceId: string;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function as(token?: string) {
    const auth = (r: request.Test) =>
      token === undefined ? r : r.set('authorization', `Bearer ${token}`);
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => auth(server().get(path)),
      post: (path: string, body: object = {}) => auth(server().post(path)).send(body),
      patch: (path: string, body: object) => auth(server().patch(path)).send(body),
      delete: (path: string) => auth(server().delete(path)),
    };
  }

  async function signIn(): Promise<Party> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, token: pair.accessToken };
  }

  async function seedMaster(verificationStatus = 'active'): Promise<Master> {
    const party = await signIn();
    const created = await as(party.token).post('/masters', { displayName: 'Usta Rəşad' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;
    await pool.query(`update masters set verification_status = $2 where id = $1`, [
      masterId,
      verificationStatus,
    ]);
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 5000, true)`,
      [masterId, serviceId],
    );
    return { ...party, masterId };
  }

  async function seedCustomer(): Promise<Party> {
    const party = await signIn();
    const created = await as(party.token).post('/customers', { displayName: 'Müştəri Səbinə' });
    expect(created.status).toBe(201);
    return party;
  }

  async function adminToken(): Promise<string> {
    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Nigar',
      roles: ['super_admin'],
    });
    return (await app.get(AdminSessionService).start(created.id)).accessToken;
  }

  async function createPost(master: Party, body: object = {}): Promise<OwnPortfolioPost> {
    const res = await as(master.token).post('/masters/me/portfolio/posts', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as OwnPortfolioPost;
  }

  function rawKeyOf(upload: PortfolioMediaUpload): string {
    return decodeURIComponent(upload.uploadUrl.slice('stub://upload/'.length));
  }

  async function presign(
    master: Party,
    postId: string,
    position: number,
    contentType = 'image/jpeg',
  ): Promise<PortfolioMediaUpload> {
    const res = await as(master.token).post(`/masters/me/portfolio/posts/${postId}/media`, {
      contentType,
      position,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PortfolioMediaUpload;
  }

  /** Presign, put the bytes where the URL points, and confirm. */
  async function upload(
    master: Party,
    postId: string,
    position: number,
    bytes: Buffer,
    contentType = 'image/jpeg',
  ): Promise<OwnPortfolioMedia> {
    const slot = await presign(master, postId, position, contentType);
    storage.putObject(rawKeyOf(slot), new Uint8Array(bytes), contentType);
    const res = await as(master.token).post(
      `/masters/me/portfolio/posts/${postId}/media/${slot.mediaId}/confirm`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as OwnPortfolioMedia;
  }

  /** What the `media` worker would do with this photo's job. */
  async function runJob(mediaId: string): Promise<void> {
    await pipeline.run({ purpose: PORTFOLIO_PHOTO_PURPOSE, itemId: mediaId });
  }

  async function getPost(master: Party, postId: string): Promise<OwnPortfolioPost> {
    const res = await as(master.token).get(`/masters/me/portfolio/posts/${postId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as OwnPortfolioPost;
  }

  /** A published post of one photo, for the limit tests. */
  async function publishedPost(master: Party): Promise<OwnPortfolioPost> {
    const post = await createPost(master);
    const media = await upload(master, post.id, 0, await solidImage('jpeg', 300, 200));
    await runJob(media.id);
    const res = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as OwnPortfolioPost).status).toBe('published');
    return res.body as OwnPortfolioPost;
  }

  function code(res: request.Response): string {
    return (res.body as ErrorEnvelope).error.code;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);
    set('MEDIA_WORKER_MODE', 'off');
    set('PORTFOLIO_MAX_POSTS', String(MAX_POSTS));
    set('PORTFOLIO_MAX_ITEMS_PER_POST', String(MAX_ITEMS));
    set('PORTFOLIO_IMAGE_MAX_BYTES', String(IMAGE_MAX_BYTES));

    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `portfolio-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'portfolio-upload': {
          ...real.policies['portfolio-upload'],
          perIdentifier: UPLOADS_PER_USER,
          perIp: 1_000_000,
        },
        'portfolio-write': {
          ...real.policies['portfolio-write'],
          perIp: 1_000_000,
        },
        'subscription-checkout': {
          ...real.policies['subscription-checkout'],
          perIp: 1_000_000,
        },
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(rateLimits)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // Bound once, here, rather than by supertest per request
    // (`master-offers.e2e.test.ts`): several tests build requests ahead of
    // sending them, and the races send theirs at the same instant.
    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pipeline = app.get(MediaPipelineService);
    mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    const services = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 2`,
    );
    serviceId = services.rows[0]?.id ?? '';
    otherServiceId = services.rows[1]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('a post from draft to published', () => {
    it('uploads four photos, publishes, and ends published with four ready photos in the order chosen', async () => {
      const master = await seedMaster();
      const post = await createPost(master, { caption: '  Mətbəx kranı dəyişildi  ', serviceId });
      expect(post).toMatchObject({
        status: 'draft',
        caption: 'Mətbəx kranı dəyişildi',
        media: [],
        publishedAt: null,
      });
      expect(post.service?.serviceId).toBe(serviceId);
      expect(typeof post.service?.name).toBe('string');

      // Each photo a different shape, so the order can be read back from the sizes.
      const shapes: [number, number][] = [
        [1600, 1200],
        [1200, 1600],
        [800, 600],
        [2000, 1000],
      ];
      const media: OwnPortfolioMedia[] = [];
      for (const [position, [width, height]] of shapes.entries()) {
        media.push(
          await upload(master, post.id, position, await solidImage('jpeg', width, height)),
        );
      }
      expect(media.map((item) => item.status)).toEqual([
        'uploaded',
        'uploaded',
        'uploaded',
        'uploaded',
      ]);

      // The confirm enqueued each photo's job, keyed by the photo.
      for (const item of media) {
        expect(await mediaQueue.getJob(`${PORTFOLIO_PHOTO_PURPOSE}-${item.id}`)).toMatchObject({
          name: PROCESS_MEDIA_JOB,
        });
      }

      // Two finish before publishing, two after.
      await runJob(media[0]?.id ?? '');
      await runJob(media[1]?.id ?? '');
      const submitted = await as(master.token).post(
        `/masters/me/portfolio/posts/${post.id}/publish`,
      );
      expect(submitted.status).toBe(200);
      expect((submitted.body as OwnPortfolioPost).status).toBe('processing');

      await runJob(media[2]?.id ?? '');
      expect((await getPost(master, post.id)).status).toBe('processing');
      await runJob(media[3]?.id ?? '');

      const published = await getPost(master, post.id);
      expect(published.status).toBe('published');
      expect(published.publishedAt).not.toBeNull();
      expect(
        published.media.map((item) => [item.position, item.status, item.width, item.height]),
      ).toEqual([
        [0, 'ready', 1440, 1080],
        [1, 'ready', 1080, 1440],
        [2, 'ready', 800, 600],
        [3, 'ready', 1440, 720],
      ]);
      for (const item of published.media) {
        expect(item.thumbUrl).toMatch(/^https:\/\/.+\/portfolio\/[0-9a-f]{32}\/thumb\.webp$/);
        expect(item.displayUrl).toMatch(/^https:\/\/.+\/portfolio\/[0-9a-f]{32}\/display\.webp$/);
      }
      // URLs, never keys: no private key and no bare rendition key in the body.
      expect(JSON.stringify(published)).not.toContain('portfolio-incoming');
      for (const item of media) {
        const { rows } = await pool.query<{ raw_storage_key: string }>(
          `select raw_storage_key from portfolio_media where id = $1`,
          [item.id],
        );
        expect(storage.hasObject(rows[0]?.raw_storage_key ?? '')).toBe(false);
      }
    });

    it('publishes at once when every photo is already ready', async () => {
      const master = await seedMaster();
      const post = await publishedPost(master);
      expect(post.publishedAt).not.toBeNull();
    });

    it('fails a processing post with the first failed photo’s code: publishing is all or nothing', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const good = await upload(master, post.id, 0, await solidImage('jpeg', 400, 300));
      const whole = await solidImage('jpeg', 800, 600);
      // A valid JPEG header, so it passes confirm's sniff, and a truncated body
      // the decoder refuses.
      const broken = await upload(
        master,
        post.id,
        1,
        whole.subarray(0, Math.floor(whole.byteLength * 0.6)),
      );
      const publish = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);
      expect((publish.body as OwnPortfolioPost).status).toBe('processing');

      await runJob(good.id);
      await expect(runJob(broken.id)).rejects.toThrow();

      const failed = await getPost(master, post.id);
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('undecodable');
      expect(failed.media.map((item) => item.status)).toEqual(['ready', 'failed']);
    });

    it('names the post’s failure after its first failed photo in position order', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const whole = await solidImage('jpeg', 800, 600);
      const first = await upload(
        master,
        post.id,
        0,
        whole.subarray(0, Math.floor(whole.byteLength * 0.6)),
      );
      const second = await upload(master, post.id, 1, await solidImage('jpeg', 400, 300));
      await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);

      // The second photo fails first — its raw upload is gone — and the
      // first fails after it.
      const { rows } = await pool.query<{ raw_storage_key: string }>(
        `select raw_storage_key from portfolio_media where id = $1`,
        [second.id],
      );
      await storage.delete(rows[0]?.raw_storage_key ?? '');
      await expect(runJob(second.id)).rejects.toThrow();

      const failed = await getPost(master, post.id);
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('missing');
      // The first photo's job is not run for a post that already failed.
      await runJob(first.id);
      expect((await getPost(master, post.id)).media.map((item) => item.status)).toEqual([
        'uploaded',
        'failed',
      ]);
    });

    it('refuses to publish a draft with a photo that already failed', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const whole = await solidImage('jpeg', 800, 600);
      const broken = await upload(
        master,
        post.id,
        0,
        whole.subarray(0, Math.floor(whole.byteLength * 0.6)),
      );
      await expect(runJob(broken.id)).rejects.toThrow();

      const res = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('PORTFOLIO_POST_NOT_READY');
    });
  });

  describe('validation', () => {
    it('refuses a malformed body on every write', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const base = `/masters/me/portfolio/posts`;
      const cases: [string, request.Test][] = [
        ['caption over the limit', as(master.token).post(base, { caption: 'x'.repeat(501) })],
        ['unknown field', as(master.token).post(base, { kind: 'video' })],
        ['service id not a uuid', as(master.token).post(base, { serviceId: 'plumbing' })],
        [
          'a video',
          as(master.token).post(`${base}/${post.id}/media`, {
            contentType: 'video/mp4',
            position: 0,
          }),
        ],
        [
          'a kind',
          as(master.token).post(`${base}/${post.id}/media`, {
            kind: 'image',
            contentType: 'image/jpeg',
            position: 0,
          }),
        ],
        [
          'position past the limit',
          as(master.token).post(`${base}/${post.id}/media`, {
            contentType: 'image/jpeg',
            position: MAX_ITEMS,
          }),
        ],
        [
          'negative position',
          as(master.token).post(`${base}/${post.id}/media`, {
            contentType: 'image/jpeg',
            position: -1,
          }),
        ],
        ['an empty edit', as(master.token).patch(`${base}/${post.id}`, {})],
        ['a post id not a uuid', as(master.token).get(`${base}/not-a-uuid`)],
        ['publish, post id not a uuid', as(master.token).post(`${base}/not-a-uuid/publish`)],
        [
          'confirm, media id not a uuid',
          as(master.token).post(`${base}/${post.id}/media/x/confirm`),
        ],
        [
          'remove photo, media id not a uuid',
          as(master.token).delete(`${base}/${post.id}/media/x`),
        ],
        [
          'an edited caption over the limit',
          as(master.token).patch(`${base}/${post.id}`, { caption: 'x'.repeat(501) }),
        ],
        ['a page of none', as(master.token).get(`${base}?limit=0`)],
        ['a page too large', as(master.token).get(`${base}?limit=51`)],
        ['an unknown query key', as(master.token).get(`${base}?status=draft`)],
      ];
      for (const [label, pending] of cases) {
        const res = await pending;
        expect(res.status, label).toBe(422);
        expect(code(res), label).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses a service the master does not offer', async () => {
      const master = await seedMaster();
      const res = await as(master.token).post('/masters/me/portfolio/posts', {
        serviceId: otherServiceId,
      });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('PORTFOLIO_SERVICE_NOT_OFFERED');
    });
  });

  describe('who may do what', () => {
    type Call = readonly [label: string, call: (token: string) => request.Test];

    function everyEndpoint(postId: string, mediaId: string): { reads: Call[]; writes: Call[] } {
      const base = `/masters/me/portfolio/posts`;
      return {
        reads: [['GET post', (token) => as(token).get(`${base}/${postId}`)]],
        writes: [
          ['create', (token) => as(token).post(base, {})],
          ['edit', (token) => as(token).patch(`${base}/${postId}`, { caption: 'x' })],
          ['delete', (token) => as(token).delete(`${base}/${postId}`)],
          ['publish', (token) => as(token).post(`${base}/${postId}/publish`)],
          [
            'presign',
            (token) =>
              as(token).post(`${base}/${postId}/media`, { contentType: 'image/jpeg', position: 5 }),
          ],
          ['confirm', (token) => as(token).post(`${base}/${postId}/media/${mediaId}/confirm`)],
          ['delete photo', (token) => as(token).delete(`${base}/${postId}/media/${mediaId}`)],
        ],
      };
    }

    async function ownedPostWithPhoto() {
      const owner = await seedMaster();
      const post = await createPost(owner);
      const slot = await presign(owner, post.id, 0);
      return { owner, postId: post.id, mediaId: slot.mediaId };
    }

    it('answers another master 404 on every endpoint for the post — never 403', async () => {
      const { postId, mediaId } = await ownedPostWithPhoto();
      const stranger = await seedMaster();
      const { reads, writes } = everyEndpoint(postId, mediaId);

      for (const [label, call] of [...reads, ...writes.slice(1)]) {
        expect((await call(stranger.token)).status, label).toBe(404);
      }
    });

    it('answers a customer 403 on every write, with a stable code', async () => {
      const { postId, mediaId } = await ownedPostWithPhoto();
      const customer = await seedCustomer();
      const { writes } = everyEndpoint(postId, mediaId);

      for (const [label, call] of writes) {
        const res = await call(customer.token);
        expect(res.status, label).toBe(403);
        expect(code(res), label).toBe('PORTFOLIO_MASTER_NOT_ACTIVE');
      }
      const list = await as(customer.token).get('/masters/me/portfolio/posts');
      expect(list.status).toBe(404);
    });

    it('answers an admin token and no token 401 on every endpoint', async () => {
      const { postId, mediaId } = await ownedPostWithPhoto();
      const admin = await adminToken();
      const { reads, writes } = everyEndpoint(postId, mediaId);

      for (const [label, call] of [...reads, ...writes]) {
        expect((await call(admin)).status, label).toBe(401);
      }
      expect((await as().get('/masters/me/portfolio/posts')).status).toBe(401);
    });

    it('lets a suspended or unverified master read their posts but change nothing', async () => {
      for (const status of ['suspended', 'pending_verification']) {
        const { owner, postId, mediaId } = await ownedPostWithPhoto();
        await pool.query(
          `update masters
              set verification_status = $2::master_verification_status,
                  suspended_at = case when $2::text = 'suspended' then now() end
            where id = $1`,
          [owner.masterId, status],
        );
        const { reads, writes } = everyEndpoint(postId, mediaId);

        for (const [label, call] of writes) {
          const res = await call(owner.token);
          expect(res.status, `${status} ${label}`).toBe(403);
          expect((res.body as ErrorEnvelope).error.details).toMatchObject({
            verificationStatus: status,
          });
        }
        for (const [label, call] of reads) {
          expect((await call(owner.token)).status, label).toBe(200);
        }
        const list = await as(owner.token).get('/masters/me/portfolio/posts');
        expect(list.status).toBe(200);
        expect((list.body as CursorPage<OwnPortfolioPost>).items.map((item) => item.id)).toEqual([
          postId,
        ]);
      }
    });
  });

  describe('limits', () => {
    it('refuses an 11th photo with a stable code', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      for (let position = 0; position < MAX_ITEMS; position += 1) {
        await presign(master, post.id, position);
      }
      const res = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/media`, {
        contentType: 'image/jpeg',
        position: 0,
      });
      expect(res.status).toBe(409);
      expect(code(res)).toBe('PORTFOLIO_MEDIA_LIMIT_EXCEEDED');
    });

    it('refuses a second photo in a taken place, and frees the place when a photo is removed', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const first = await presign(master, post.id, 0);

      const taken = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/media`, {
        contentType: 'image/png',
        position: 0,
      });
      expect(taken.status).toBe(409);
      expect(code(taken)).toBe('PORTFOLIO_MEDIA_POSITION_TAKEN');

      const removed = await as(master.token).delete(
        `/masters/me/portfolio/posts/${post.id}/media/${first.mediaId}`,
      );
      expect(removed.status).toBe(204);
      await presign(master, post.id, 0);
      const { rows } = await pool.query<{ media_count: number }>(
        `select media_count from portfolio_posts where id = $1`,
        [post.id],
      );
      expect(rows[0]?.media_count).toBe(1);
    });

    it('refuses a post beyond PORTFOLIO_MAX_POSTS, counting processing and published ones', async () => {
      const master = await seedMaster();
      for (let i = 0; i < MAX_POSTS - 1; i += 1) {
        await publishedPost(master);
      }
      // The last slot taken by a post still processing.
      const processing = await createPost(master);
      await upload(master, processing.id, 0, await solidImage('jpeg', 300, 200));
      const submitted = await as(master.token).post(
        `/masters/me/portfolio/posts/${processing.id}/publish`,
      );
      expect((submitted.body as OwnPortfolioPost).status).toBe('processing');

      const extra = await createPost(master);
      await runJob((await upload(master, extra.id, 0, await solidImage('jpeg', 300, 200))).id);

      const res = await as(master.token).post(`/masters/me/portfolio/posts/${extra.id}/publish`);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('PORTFOLIO_POST_LIMIT_EXCEEDED');
      expect((await getPost(master, extra.id)).status).toBe('draft');
    });

    it('frees a slot for a post deleted, failed or removed by an admin', async () => {
      const master = await seedMaster();
      const posts: OwnPortfolioPost[] = [];
      for (let i = 0; i < MAX_POSTS; i += 1) {
        posts.push(await publishedPost(master));
      }
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['moderator'],
      });

      const free: ((id: string) => Promise<unknown>)[] = [
        (id) => as(master.token).delete(`/masters/me/portfolio/posts/${id}`),
        (id) => pool.query(`update portfolio_posts set status = 'failed' where id = $1`, [id]),
        (id) =>
          pool.query(
            `update portfolio_posts
                set removed_at = now(), removed_by_admin_id = $2, removal_reason = 'Qayda pozuntusu'
              where id = $1`,
            [id, admin.id],
          ),
      ];
      for (const [i, release] of free.entries()) {
        await release(posts[i]?.id ?? '');
        const next = await createPost(master);
        await runJob((await upload(master, next.id, 0, await solidImage('jpeg', 200, 200))).id);
        const res = await as(master.token).post(`/masters/me/portfolio/posts/${next.id}/publish`);
        expect(res.status, `slot ${String(i)}`).toBe(200);
      }
    });

    it('refuses a photo over PORTFOLIO_IMAGE_MAX_BYTES, deletes it, and lets the same upload be retried', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const slot = await presign(master, post.id, 0);
      const key = rawKeyOf(slot);
      const tooLarge = Buffer.alloc(IMAGE_MAX_BYTES + 1);
      tooLarge.set([0xff, 0xd8, 0xff]);
      storage.putObject(key, new Uint8Array(tooLarge), 'image/jpeg');

      const confirm = `/masters/me/portfolio/posts/${post.id}/media/${slot.mediaId}/confirm`;
      const refused = await as(master.token).post(confirm);
      expect(refused.status).toBe(422);
      expect(code(refused)).toBe('PORTFOLIO_MEDIA_TOO_LARGE');
      expect(storage.hasObject(key)).toBe(false);

      storage.putObject(key, new Uint8Array(await solidImage('jpeg', 300, 200)), 'image/jpeg');
      const retried = await as(master.token).post(confirm);
      expect(retried.status).toBe(200);
    });

    it.each([
      [
        'a JPEG presigned as a PNG',
        'image/png',
        () => solidImage('jpeg', 100, 100),
        'PORTFOLIO_MEDIA_CONTENT_MISMATCH',
      ],
      [
        'bytes that are no image',
        'image/jpeg',
        () => Promise.resolve(Buffer.from('not a photo at all')),
        'PORTFOLIO_MEDIA_CONTENT_MISMATCH',
      ],
      [
        'an iPhone HEIC',
        'image/jpeg',
        () =>
          Promise.resolve(
            Buffer.concat([
              Buffer.from([0, 0, 0, 0x18]),
              Buffer.from('ftypheic'),
              Buffer.alloc(64),
            ]),
          ),
        'PORTFOLIO_MEDIA_HEIC_UNSUPPORTED',
      ],
    ])('refuses %s at confirm with its own code', async (_label, contentType, bytes, expected) => {
      const master = await seedMaster();
      const post = await createPost(master);
      const slot = await presign(master, post.id, 0, contentType);
      storage.putObject(rawKeyOf(slot), new Uint8Array(await bytes()), contentType);

      const res = await as(master.token).post(
        `/masters/me/portfolio/posts/${post.id}/media/${slot.mediaId}/confirm`,
      );
      expect(res.status).toBe(422);
      expect(code(res)).toBe(expected);
      expect(storage.hasObject(rawKeyOf(slot))).toBe(false);
    });

    it('answers a confirm before the upload, and a second confirm, with their own codes', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const slot = await presign(master, post.id, 0);
      const confirm = `/masters/me/portfolio/posts/${post.id}/media/${slot.mediaId}/confirm`;

      const early = await as(master.token).post(confirm);
      expect(early.status).toBe(409);
      expect(code(early)).toBe('PORTFOLIO_MEDIA_NOT_UPLOADED');

      storage.putObject(
        rawKeyOf(slot),
        new Uint8Array(await solidImage('jpeg', 100, 100)),
        'image/jpeg',
      );
      expect((await as(master.token).post(confirm)).status).toBe(200);
      const again = await as(master.token).post(confirm);
      expect(again.status).toBe(409);
      expect(code(again)).toBe('PORTFOLIO_MEDIA_ALREADY_CONFIRMED');
    });

    it('refuses to publish a post with no photos, or with a photo not uploaded', async () => {
      const master = await seedMaster();
      const empty = await createPost(master);
      const noPhotos = await as(master.token).post(
        `/masters/me/portfolio/posts/${empty.id}/publish`,
      );
      expect(code(noPhotos)).toBe('PORTFOLIO_POST_NOT_READY');

      await presign(master, empty.id, 0);
      const pending = await as(master.token).post(
        `/masters/me/portfolio/posts/${empty.id}/publish`,
      );
      expect(pending.status).toBe(409);
      expect(code(pending)).toBe('PORTFOLIO_POST_NOT_READY');
    });

    it('answers 429 on presign once the master’s upload budget is spent', async () => {
      const master = await seedMaster();
      const statuses: number[] = [];
      let post = await createPost(master);
      for (let call = 0; call <= UPLOADS_PER_USER; call += 1) {
        if (call > 0 && call % MAX_ITEMS === 0) {
          post = await createPost(master);
        }
        const res = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/media`, {
          contentType: 'image/jpeg',
          position: call % MAX_ITEMS,
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, UPLOADS_PER_USER).every((status) => status === 201)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('invalid transitions', () => {
    it('refuses to publish a post that is processing, published or failed', async () => {
      const master = await seedMaster();
      const published = await publishedPost(master);
      const processing = await createPost(master);
      await upload(master, processing.id, 0, await solidImage('jpeg', 200, 200));
      await as(master.token).post(`/masters/me/portfolio/posts/${processing.id}/publish`);
      const failed = await createPost(master);
      await pool.query(`update portfolio_posts set status = 'failed' where id = $1`, [failed.id]);

      for (const post of [published, processing, failed]) {
        const res = await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);
        expect(res.status, post.id).toBe(409);
        expect(code(res)).toBe('PORTFOLIO_POST_NOT_EDITABLE');
      }
    });

    it('refuses to edit a post that is processing or failed, and deletes a failed one', async () => {
      const master = await seedMaster();
      const processing = await createPost(master);
      await upload(master, processing.id, 0, await solidImage('jpeg', 200, 200));
      await as(master.token).post(`/masters/me/portfolio/posts/${processing.id}/publish`);
      const failed = await createPost(master);
      await pool.query(`update portfolio_posts set status = 'failed' where id = $1`, [failed.id]);

      for (const post of [processing, failed]) {
        const res = await as(master.token).patch(`/masters/me/portfolio/posts/${post.id}`, {
          caption: 'x',
        });
        expect(res.status).toBe(409);
        expect(code(res)).toBe('PORTFOLIO_POST_NOT_EDITABLE');
      }
      expect(
        (await as(master.token).delete(`/masters/me/portfolio/posts/${failed.id}`)).status,
      ).toBe(204);
    });
  });

  describe('editing, deleting and listing', () => {
    it('edits a published post’s caption, but not its tag', async () => {
      const master = await seedMaster();
      const post = await publishedPost(master);
      const base = `/masters/me/portfolio/posts/${post.id}`;

      const captioned = await as(master.token).patch(base, { caption: 'Yeni izah' });
      expect(captioned.status).toBe(200);
      expect((captioned.body as OwnPortfolioPost).caption).toBe('Yeni izah');

      const cleared = await as(master.token).patch(base, { caption: '   ' });
      expect((cleared.body as OwnPortfolioPost).caption).toBeNull();

      const retagged = await as(master.token).patch(base, { serviceId });
      expect(retagged.status).toBe(409);
      expect(code(retagged)).toBe('PORTFOLIO_POST_NOT_EDITABLE');
    });

    it('removes a ready photo’s renditions when it is taken out of a draft', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const media = await upload(master, post.id, 0, await solidImage('jpeg', 300, 200));
      await runJob(media.id);
      const { rows } = await pool.query<{ thumb_key: string; display_key: string }>(
        `select thumb_key, display_key from portfolio_media where id = $1`,
        [media.id],
      );
      const keys = [rows[0]?.thumb_key ?? '', rows[0]?.display_key ?? ''];
      for (const key of keys) {
        expect(storage.getPublicObject(key)).toBeDefined();
      }

      const res = await as(master.token).delete(
        `/masters/me/portfolio/posts/${post.id}/media/${media.id}`,
      );
      expect(res.status).toBe(204);
      for (const key of keys) {
        expect(storage.getPublicObject(key)).toBeUndefined();
      }
      expect((await getPost(master, post.id)).media).toEqual([]);
    });

    it('re-tags a draft, and refuses to change a published post’s photos', async () => {
      const master = await seedMaster();
      const draft = await createPost(master);
      const tagged = await as(master.token).patch(`/masters/me/portfolio/posts/${draft.id}`, {
        serviceId,
      });
      expect(tagged.status).toBe(200);

      const published = await publishedPost(master);
      const added = await as(master.token).post(
        `/masters/me/portfolio/posts/${published.id}/media`,
        {
          contentType: 'image/jpeg',
          position: 1,
        },
      );
      expect(added.status).toBe(409);
      expect(code(added)).toBe('PORTFOLIO_POST_NOT_EDITABLE');
      const removed = await as(master.token).delete(
        `/masters/me/portfolio/posts/${published.id}/media/${published.media[0]?.id ?? ''}`,
      );
      expect(removed.status).toBe(409);
    });

    it('deletes a post at once and idempotently, and hides it from every read', async () => {
      const master = await seedMaster();
      const post = await publishedPost(master);
      const base = `/masters/me/portfolio/posts/${post.id}`;

      expect((await as(master.token).delete(base)).status).toBe(204);
      expect((await as(master.token).delete(base)).status).toBe(204);
      expect((await as(master.token).get(base)).status).toBe(404);
      const list = await as(master.token).get('/masters/me/portfolio/posts');
      expect((list.body as CursorPage<OwnPortfolioPost>).items).toEqual([]);

      const { rows } = await pool.query<{ status: string; deleted_at: Date | null }>(
        `select status, deleted_at from portfolio_posts where id = $1`,
        [post.id],
      );
      expect(rows[0]?.status).toBe('deleted');
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it('refuses to delete or edit a post an admin removed — it is the evidence of the removal', async () => {
      const master = await seedMaster();
      const post = await publishedPost(master);
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['moderator'],
      });
      await pool.query(
        `update portfolio_posts
            set removed_at = now(), removed_by_admin_id = $2, removal_reason = 'Ev nömrəsi görünür'
          where id = $1`,
        [post.id, admin.id],
      );

      const base = `/masters/me/portfolio/posts/${post.id}`;
      expect(code(await as(master.token).delete(base))).toBe('PORTFOLIO_POST_NOT_EDITABLE');
      expect(code(await as(master.token).patch(base, { caption: 'x' }))).toBe(
        'PORTFOLIO_POST_NOT_EDITABLE',
      );
      expect((await getPost(master, post.id)).removedAt).not.toBeNull();
    });

    it('lists every status but deleted, newest first, a page at a time', async () => {
      const master = await seedMaster();
      const published = await publishedPost(master);
      const processing = await createPost(master);
      const media = await upload(master, processing.id, 0, await solidImage('jpeg', 200, 200));
      await as(master.token).post(`/masters/me/portfolio/posts/${processing.id}/publish`);
      const draft = await createPost(master);
      const gone = await createPost(master);
      await as(master.token).delete(`/masters/me/portfolio/posts/${gone.id}`);

      const first = await as(master.token).get('/masters/me/portfolio/posts?limit=2');
      expect(first.status).toBe(200);
      const page1 = first.body as CursorPage<OwnPortfolioPost>;
      expect(page1.items.map((item) => [item.id, item.status])).toEqual([
        [draft.id, 'draft'],
        [processing.id, 'processing'],
      ]);
      expect(page1.items[1]?.media.map((item) => [item.id, item.status])).toEqual([
        [media.id, 'uploaded'],
      ]);
      expect(page1.nextCursor).not.toBeNull();

      const second = await as(master.token).get(
        `/masters/me/portfolio/posts?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
      );
      const page2 = second.body as CursorPage<OwnPortfolioPost>;
      expect(page2.items.map((item) => item.id)).toEqual([published.id]);
      expect(page2.nextCursor).toBeNull();

      const garbage = await as(master.token).get('/masters/me/portfolio/posts?cursor=not-a-cursor');
      expect(garbage.status).toBe(200);
    });

    it('answers a cursor naming another master’s post with an empty page, as for no post (#391)', async () => {
      const master = await seedMaster();
      await createPost(master);
      const other = await seedMaster();
      // Newer than the master's post, so a cursor read from it would page
      // straight back into the master's own list.
      const theirs = await createPost(other);
      const cursor = Buffer.from(JSON.stringify({ p: theirs.id })).toString('base64url');

      const res = await as(master.token).get(
        `/masters/me/portfolio/posts?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(res.status).toBe(200);
      expect((res.body as CursorPage<OwnPortfolioPost>).items).toEqual([]);
    });
  });

  describe('races', () => {
    it('lets exactly one of two publishes racing for the last slot win', async () => {
      const master = await seedMaster();
      for (let i = 0; i < MAX_POSTS - 1; i += 1) {
        await publishedPost(master);
      }
      const drafts: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const draft = await createPost(master);
        await runJob((await upload(master, draft.id, 0, await solidImage('jpeg', 300, 200))).id);
        drafts.push(draft.id);
      }

      const results = await Promise.all(
        drafts.map((id) => as(master.token).post(`/masters/me/portfolio/posts/${id}/publish`)),
      );

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(results.map((res) => (res.status === 409 ? code(res) : 'ok')).sort()).toEqual([
        'PORTFOLIO_POST_LIMIT_EXCEEDED',
        'ok',
      ]);
      const { rows } = await pool.query<{ count: number }>(
        `select count(*)::int as count from portfolio_posts
          where master_id = $1 and status in ('processing', 'published')`,
        [master.masterId],
      );
      expect(rows[0]?.count).toBe(MAX_POSTS);
    });

    it('lets exactly one of six publishes racing in the database for the last slot win', async () => {
      // Below HTTP, so the six transactions overlap as tightly as they can:
      // without the per-master lock each would count the same posts, see room
      // for one more, and publish.
      const master = await seedMaster();
      for (let i = 0; i < MAX_POSTS - 1; i += 1) {
        await publishedPost(master);
      }
      const drafts: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const draft = await createPost(master);
        await pool.query(
          `insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                        verified_content_type, raw_size_bytes, status, presign_expires_at,
                                        thumb_key, display_key, width, height, bytes_total)
           values (gen_random_uuid(), $1::uuid, 0, 'portfolio-incoming/race-' || $1::text, 'image/jpeg',
                   'image/jpeg', 1000, 'ready', now(), 'portfolio/race-' || $1::text || '/thumb.webp',
                   'portfolio/race-' || $1::text || '/display.webp', 300, 200, 2000)`,
          [draft.id],
        );
        drafts.push(draft.id);
      }

      const repository = app.get(PortfolioRepository);
      const outcomes = await Promise.all(
        drafts.map((postId) =>
          repository.publish({
            masterId: master.masterId,
            postId,
            maxPosts: MAX_POSTS,
            now: new Date(),
          }),
        ),
      );

      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
        'limit_exceeded',
        'limit_exceeded',
        'limit_exceeded',
        'limit_exceeded',
        'limit_exceeded',
        'published',
      ]);
    });

    it('discards the renditions when the post is deleted between claim and completion', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const media = await upload(master, post.id, 0, await solidImage('jpeg', 600, 400));
      await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);
      const target = app.get(PortfolioMediaTarget);

      expect(await target.load(media.id)).toBeDefined();
      await as(master.token).delete(`/masters/me/portfolio/posts/${post.id}`);
      const outcome = await target.complete(media.id, [
        { name: 'thumb', key: 'portfolio/race/thumb.webp', width: 480, height: 320, bytes: 10 },
        { name: 'display', key: 'portfolio/race/display.webp', width: 600, height: 400, bytes: 20 },
      ]);
      expect(outcome).toBe('discarded');
    });

    it('leaves a ready photo on the deleted post when completion commits before the delete', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const media = await upload(master, post.id, 0, await solidImage('jpeg', 600, 400));
      await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);

      await runJob(media.id);
      expect((await getPost(master, post.id)).status).toBe('published');
      await as(master.token).delete(`/masters/me/portfolio/posts/${post.id}`);

      const { rows } = await pool.query<{ post_status: string; media_status: string }>(
        `select p.status as post_status, m.status as media_status
           from portfolio_media m join portfolio_posts p on p.id = m.post_id where m.id = $1`,
        [media.id],
      );
      // Its renditions stay recorded on the deleted post's photo, for the sweep (#311).
      expect(rows[0]).toEqual({ post_status: 'deleted', media_status: 'ready' });
    });

    it('accepts a second completion of the same photo with the same keys, and deletes nothing', async () => {
      const master = await seedMaster();
      const post = await createPost(master);
      const media = await upload(master, post.id, 0, await solidImage('jpeg', 600, 400));
      await runJob(media.id);
      const { rows } = await pool.query<{ thumb_key: string; display_key: string }>(
        `select thumb_key, display_key from portfolio_media where id = $1`,
        [media.id],
      );
      const renditions = [
        { name: 'thumb', key: rows[0]?.thumb_key ?? '', width: 480, height: 320, bytes: 10 },
        { name: 'display', key: rows[0]?.display_key ?? '', width: 600, height: 400, bytes: 20 },
      ];

      expect(await app.get(PortfolioMediaTarget).complete(media.id, renditions)).toBe('accepted');
    });

    it('ends a post deleted mid-processing deleted, with no rendition left referenced by a live post', async () => {
      // Run a few times: either the delete or the completion commits first,
      // and both orders must end the same way.
      for (let round = 0; round < 4; round += 1) {
        const master = await seedMaster();
        const post = await createPost(master);
        const media = await upload(master, post.id, 0, await solidImage('jpeg', 600, 400));
        await as(master.token).post(`/masters/me/portfolio/posts/${post.id}/publish`);

        const [deleted] = await Promise.all([
          as(master.token).delete(`/masters/me/portfolio/posts/${post.id}`),
          runJob(media.id),
        ]);
        expect(deleted.status).toBe(204);

        const { rows } = await pool.query<{
          post_status: string;
          media_status: string;
          thumb_key: string | null;
          display_key: string | null;
        }>(
          `select p.status as post_status, m.status as media_status, m.thumb_key, m.display_key
             from portfolio_media m join portfolio_posts p on p.id = m.post_id
            where m.id = $1`,
          [media.id],
        );
        const row = rows[0];
        expect(row?.post_status).toBe('deleted');
        // A rendition still in the bucket is recorded on the deleted post's
        // photo, where the sweep (#311) finds it; any other is gone already.
        for (const key of [row?.thumb_key, row?.display_key]) {
          if (key !== null && key !== undefined && storage.getPublicObject(key) !== undefined) {
            expect(row?.media_status).toBe('ready');
          }
        }
        expect((await as(master.token).get(`/masters/me/portfolio/posts/${post.id}`)).status).toBe(
          404,
        );
      }
    });
  });
});
