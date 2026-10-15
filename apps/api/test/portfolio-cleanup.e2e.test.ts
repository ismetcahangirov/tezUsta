import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Master } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { CDN_PURGER } from '../src/infra/cdn/cdn-purger.types';
import type { StubCdnPurger } from '../src/infra/cdn/stub-cdn-purger';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { MEDIA_QUEUE } from '../src/infra/queue/queue.constants';
import { PUBLIC_MEDIA_CACHE_CONTROL, STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { MASTER_ACCOUNT_DELETED_JOB } from '../src/modules/masters/masters.service';
import {
  DELETE_PORTFOLIO_POST_JOB,
  PortfolioCleanupService,
} from '../src/modules/portfolio/portfolio-cleanup.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

interface SeededMaster {
  readonly userId: string;
  readonly token: string;
  readonly masterId: string;
}

interface SeededPost {
  readonly id: string;
  readonly publicKeys: string[];
  readonly rawKeys: string[];
}

/**
 * The portfolio's deletion job and sweep (#311, ADR-0045 § 6), against the
 * stub storage and the stub purger: what goes, what is never touched, and
 * that a storage outage loses nothing.
 */
describe('portfolio deletion and sweeps (issue #311)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let storage: StubStorageProvider;
  let purger: StubCdnPurger;
  let cleanup: PortfolioCleanupService;
  let mediaQueue: Queue;
  let fileDir: string;
  let renditionFile: string;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function seedMaster(): Promise<SeededMaster> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const res = await request(app.getHttpServer())
      .post('/masters')
      .set('authorization', `Bearer ${pair.accessToken}`)
      .send({ displayName: 'Usta Kamran' });
    expect(res.status).toBe(201);
    const masterId = (res.body as { id: string }).id;
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [masterId]);
    return { userId: created.user.id, token: pair.accessToken, masterId };
  }

  /** A public rendition in the stub bucket. */
  async function putRendition(key: string): Promise<void> {
    await storage.putPublic({
      key,
      filePath: renditionFile,
      contentType: 'image/webp',
      cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
    });
  }

  /**
   * A post in `status` with two ready photos whose renditions and raw uploads
   * are in storage, last touched `ageHours` ago.
   */
  async function seedPost(
    master: SeededMaster,
    status: 'draft' | 'processing' | 'published' | 'failed' | 'deleted',
    ageHours = 0,
  ): Promise<SeededPost> {
    const id = randomUUID();
    await pool.query(
      `insert into portfolio_posts (id, master_id, status, media_count, published_at, deleted_at,
                                    created_at, updated_at)
       values ($1, $2, $3::portfolio_post_status, 2,
               case when $3::text = 'published' then now() end,
               case when $3::text = 'deleted' then now() end,
               now() - make_interval(hours => $4), now() - make_interval(hours => $4))`,
      [id, master.masterId, status, ageHours],
    );
    const publicKeys: string[] = [];
    const rawKeys: string[] = [];
    for (let position = 0; position < 2; position += 1) {
      const token = randomUUID();
      const raw = `portfolio-incoming/${token}`;
      const thumb = `portfolio/${token}/thumb.webp`;
      const display = `portfolio/${token}/display.webp`;
      await pool.query(
        `insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                      verified_content_type, raw_size_bytes, status, presign_expires_at,
                                      thumb_key, display_key, width, height, bytes_total, updated_at)
         values (gen_random_uuid(), $1::uuid, $2::int, $3, 'image/jpeg', 'image/jpeg', 1000, 'ready', now(),
                 $4, $5, 1440, 1080, 3000, now() - make_interval(hours => $6))`,
        [id, position, raw, thumb, display, ageHours],
      );
      storage.putObject(raw, new Uint8Array([1, 2, 3]), 'image/jpeg');
      await putRendition(thumb);
      await putRendition(display);
      publicKeys.push(thumb, display);
      rawKeys.push(raw);
    }
    return { id, publicKeys, rawKeys };
  }

  async function postStatus(postId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      `select status from portfolio_posts where id = $1`,
      [postId],
    );
    return rows[0]?.status;
  }

  function expectGone(post: SeededPost): void {
    for (const key of post.publicKeys) {
      expect(storage.getPublicObject(key), key).toBeUndefined();
    }
    for (const key of post.rawKeys) {
      expect(storage.hasObject(key), key).toBe(false);
    }
  }

  function expectKept(post: SeededPost): void {
    for (const key of post.publicKeys) {
      expect(storage.getPublicObject(key), key).toBeDefined();
    }
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);
    set('MEDIA_WORKER_MODE', 'off');
    set('MAINTENANCE_SWEEP_INTERVAL_MINUTES', '0');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    purger = app.get<StubCdnPurger>(CDN_PURGER);
    cleanup = app.get(PortfolioCleanupService);
    mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    fileDir = await mkdtemp(path.join(tmpdir(), 'portfolio-cleanup-'));
    renditionFile = path.join(fileDir, 'rendition.webp');
    await writeFile(renditionFile, 'webp');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    await rm(fileDir, { recursive: true, force: true });
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('deleting a post', () => {
    it('enqueues a job that deletes every object, purges every URL, and only then the rows', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'published');

      const res = await request(app.getHttpServer())
        .delete(`/masters/me/portfolio/posts/${post.id}`)
        .set('authorization', `Bearer ${master.token}`);
      expect(res.status).toBe(204);
      expect(await mediaQueue.getJob(`portfolio-post-delete-${post.id}`)).toBeDefined();
      expectKept(post);

      await app.get(DeferredJobHandlerRegistry).resolve(DELETE_PORTFOLIO_POST_JOB)({
        postId: post.id,
      });

      expectGone(post);
      expect(purger.purged()).toEqual(
        expect.arrayContaining(post.publicKeys.map((key) => storage.publicUrl(key))),
      );
      expect(await postStatus(post.id)).toBeUndefined();
      const { rows } = await pool.query(`select 1 from portfolio_media where post_id = $1`, [
        post.id,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('keeps the rows when storage fails, and finishes on the next run', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'deleted');
      const deletePublic = storage.deletePublic.bind(storage);
      storage.deletePublic = () => Promise.reject(new Error('storage unavailable'));
      try {
        await expect(cleanup.deletePost(post.id)).rejects.toThrow('storage unavailable');
      } finally {
        storage.deletePublic = deletePublic;
      }
      expect(await postStatus(post.id)).toBe('deleted');
      expectKept(post);

      expect(await cleanup.deletePost(post.id)).toBe(true);
      expectGone(post);
      expect(await postStatus(post.id)).toBeUndefined();
    });

    it('keeps the rows when the CDN purge fails, so the purge is retried with its URLs', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'deleted');
      const purge = purger.purgeUrls.bind(purger);
      purger.purgeUrls = () => Promise.reject(new Error('cdn unavailable'));
      try {
        await expect(cleanup.deletePost(post.id)).rejects.toThrow('cdn unavailable');
      } finally {
        purger.purgeUrls = purge;
      }
      expect(await postStatus(post.id)).toBe('deleted');

      expect(await cleanup.deletePost(post.id)).toBe(true);
      expect(await postStatus(post.id)).toBeUndefined();
    });

    it('does nothing to a post that is not deleted', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'published');

      expect(await cleanup.deletePost(post.id)).toBe(false);
      expectKept(post);
      expect(await postStatus(post.id)).toBe('published');
    });
  });

  describe('the sweep', () => {
    it('removes uploads abandoned past their window, with their raw objects, and frees their places', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'draft');
      const old = `portfolio-incoming/${randomUUID()}`;
      const fresh = `portfolio-incoming/${randomUUID()}`;
      await pool.query(
        `insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                      status, presign_expires_at)
         values (gen_random_uuid(), $1, 2, $2, 'image/jpeg', 'awaiting_upload', now() - interval '30 hours'),
                (gen_random_uuid(), $1, 3, $3, 'image/jpeg', 'awaiting_upload', now() - interval '1 hour')`,
        [post.id, old, fresh],
      );
      await pool.query(`update portfolio_posts set media_count = 4 where id = $1`, [post.id]);
      storage.putObject(old, new Uint8Array([1]), 'image/jpeg');
      storage.putObject(fresh, new Uint8Array([1]), 'image/jpeg');

      await cleanup.sweep();

      expect(storage.hasObject(old)).toBe(false);
      expect(storage.hasObject(fresh)).toBe(true);
      const { rows } = await pool.query<{ raw_storage_key: string }>(
        `select raw_storage_key from portfolio_media where post_id = $1 and status = 'awaiting_upload'`,
        [post.id],
      );
      expect(rows.map((row) => row.raw_storage_key)).toEqual([fresh]);
      const count = await pool.query<{ media_count: number }>(
        `select media_count from portfolio_posts where id = $1`,
        [post.id],
      );
      expect(count.rows[0]?.media_count).toBe(3);
    });

    it('deletes an abandoned draft and an old failed post whole, and leaves fresh ones', async () => {
      const master = await seedMaster();
      const oldDraft = await seedPost(master, 'draft', 80);
      const oldFailed = await seedPost(master, 'failed', 80);
      const freshDraft = await seedPost(master, 'draft', 1);

      await cleanup.sweep();

      for (const post of [oldDraft, oldFailed]) {
        expect(await postStatus(post.id)).toBeUndefined();
        expectGone(post);
      }
      expect(await postStatus(freshDraft.id)).toBe('draft');
      expectKept(freshDraft);
    });

    it('finishes a deleted post whose job never ran, once its grace has passed', async () => {
      const master = await seedMaster();
      const stale = await seedPost(master, 'deleted', 1);
      const recent = await seedPost(master, 'deleted', 0);

      await cleanup.sweep();

      expect(await postStatus(stale.id)).toBeUndefined();
      expectGone(stale);
      // A minute old: its own job still has the floor.
      expect(await postStatus(recent.id)).toBe('deleted');
    });

    it('fails photos stuck in processing, and their post with them', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'processing');
      await pool.query(
        `update portfolio_media
            set status = 'processing', thumb_key = null, display_key = null, width = null, height = null,
                bytes_total = null, updated_at = now() - interval '7 hours'
          where post_id = $1 and position = 1`,
        [post.id],
      );

      await cleanup.sweep();

      expect(await postStatus(post.id)).toBe('failed');
      const { rows } = await pool.query<{ status: string; failure_code: string | null }>(
        `select status, failure_code from portfolio_media where post_id = $1 and position = 1`,
        [post.id],
      );
      expect(rows[0]).toEqual({ status: 'failed', failure_code: 'processing_failed' });
    });

    it('never touches a published post, a removed one, or a suspended master’s, however old', async () => {
      const master = await seedMaster();
      const published = await seedPost(master, 'published', 2_000);
      const removed = await seedPost(master, 'published', 2_000);
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['moderator'],
      });
      await pool.query(
        `update portfolio_posts set removed_at = now() - interval '1 day', removed_by_admin_id = $2,
                removal_reason = 'Qayda pozuntusu' where id = $1`,
        [removed.id, admin.id],
      );
      const suspended = await seedMaster();
      const suspendedPost = await seedPost(suspended, 'published', 2_000);
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [suspended.masterId],
      );

      await cleanup.sweep();

      for (const post of [published, suspendedPost]) {
        expect(await postStatus(post.id)).toBe('published');
        expectKept(post);
      }
      // A removed post is never deleted: its row stays, and its photos are
      // kept as evidence in the private bucket within their retention (#312).
      expect(await postStatus(removed.id)).toBe('published');
      for (const key of removed.publicKeys) {
        expect(storage.hasObject(`portfolio-evidence/${key}`), key).toBe(true);
      }
    });
  });

  describe('the avatar', () => {
    async function seedUpload(
      master: SeededMaster,
      status: string,
      options: { keys?: boolean; ageHours?: number; presignAgeHours?: number } = {},
    ): Promise<{ id: string; thumb: string; display: string; raw: string }> {
      const id = randomUUID();
      const token = randomUUID();
      const thumb = `avatars/${token}/thumb.webp`;
      const display = `avatars/${token}/display.webp`;
      const raw = `avatar-incoming/${token}`;
      const keys = options.keys ?? false;
      await pool.query(
        `insert into master_avatar_uploads (id, master_id, raw_storage_key, declared_content_type,
                                            verified_content_type, raw_size_bytes, status, failure_code,
                                            presign_expires_at, thumb_key, display_key, updated_at)
         values ($1, $2, $3, 'image/jpeg',
                 case when $4::text = 'awaiting_upload' then null else 'image/jpeg' end,
                 case when $4::text = 'awaiting_upload' then null else 1000 end,
                 $4::media_upload_status,
                 case when $4::text = 'failed' then 'cancelled' end,
                 now() - make_interval(hours => $7), $5, $6, now() - make_interval(hours => $8))`,
        [
          id,
          master.masterId,
          raw,
          status,
          keys ? thumb : null,
          keys ? display : null,
          options.presignAgeHours ?? 0,
          options.ageHours ?? 0,
        ],
      );
      storage.putObject(raw, new Uint8Array([1]), 'image/jpeg');
      if (keys) {
        await putRendition(thumb);
        await putRendition(display);
      }
      return { id, thumb, display, raw };
    }

    it('deletes renditions no longer the avatar, and never the current one', async () => {
      const master = await seedMaster();
      const replaced = await seedUpload(master, 'ready', { keys: true, ageHours: 1 });
      const current = await seedUpload(master, 'ready', { keys: true, ageHours: 1 });
      await pool.query(
        `update masters set avatar_thumb_key = $2, avatar_display_key = $3 where id = $1`,
        [master.masterId, current.thumb, current.display],
      );

      await cleanup.sweep();

      expect(storage.getPublicObject(replaced.thumb)).toBeUndefined();
      expect(storage.getPublicObject(replaced.display)).toBeUndefined();
      expect(storage.getPublicObject(current.thumb)).toBeDefined();
      expect(storage.getPublicObject(current.display)).toBeDefined();
    });

    it('removes an abandoned avatar upload with its raw object, and fails a stuck one', async () => {
      const master = await seedMaster();
      const abandoned = await seedUpload(master, 'awaiting_upload', { presignAgeHours: 30 });
      await cleanup.sweep();
      expect(storage.hasObject(abandoned.raw)).toBe(false);
      const gone = await pool.query(`select 1 from master_avatar_uploads where id = $1`, [
        abandoned.id,
      ]);
      expect(gone.rows).toHaveLength(0);

      const stuck = await seedUpload(master, 'processing', { ageHours: 7 });
      await cleanup.sweep();
      const { rows } = await pool.query<{ status: string; failure_code: string }>(
        `select status, failure_code from master_avatar_uploads where id = $1`,
        [stuck.id],
      );
      expect(rows[0]).toEqual({ status: 'failed', failure_code: 'processing_failed' });
    });
  });

  describe('deleting the account', () => {
    it('hides every post at once, keeps an admin-removed one, and the job then deletes the rest', async () => {
      const master = await seedMaster();
      const published = await seedPost(master, 'published');
      const draft = await seedPost(master, 'draft');
      const removed = await seedPost(master, 'published');
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['moderator'],
      });
      await pool.query(
        `update portfolio_posts set removed_at = now(), removed_by_admin_id = $2,
                removal_reason = 'Qayda pozuntusu' where id = $1`,
        [removed.id, admin.id],
      );
      const avatarToken = randomUUID();
      const thumb = `avatars/${avatarToken}/thumb.webp`;
      const display = `avatars/${avatarToken}/display.webp`;
      await pool.query(
        `insert into master_avatar_uploads (id, master_id, raw_storage_key, declared_content_type,
                                            verified_content_type, raw_size_bytes, status,
                                            presign_expires_at, thumb_key, display_key, created_at)
         values (gen_random_uuid(), $1, 'avatar-incoming/' || gen_random_uuid(), 'image/jpeg', 'image/jpeg',
                 1000, 'ready', now(), $2, $3, now() - interval '1 hour')`,
        [master.masterId, thumb, display],
      );
      await pool.query(
        `update masters set avatar_thumb_key = $2, avatar_display_key = $3 where id = $1`,
        [master.masterId, thumb, display],
      );
      await putRendition(thumb);
      await putRendition(display);

      const deleted = await request(app.getHttpServer())
        .delete('/masters/me')
        .set('authorization', `Bearer ${master.token}`);
      expect(deleted.status).toBe(204);

      // Hidden in the same transaction as the account, before any job runs.
      expect(await postStatus(published.id)).toBe('deleted');
      expect(await postStatus(draft.id)).toBe('deleted');
      expect(await postStatus(removed.id)).toBe('published');

      const jobs = await mediaQueue.getJobs(['waiting', 'delayed', 'prioritized']);
      const job = jobs.find(
        (candidate) =>
          candidate.name === MASTER_ACCOUNT_DELETED_JOB &&
          (candidate.data as { masterId?: string }).masterId === master.masterId,
      );
      expect(job).toBeDefined();
      await app.get(DeferredJobHandlerRegistry).resolve(MASTER_ACCOUNT_DELETED_JOB)(
        (job?.data ?? {}) as Record<string, unknown>,
      );

      for (const post of [published, draft]) {
        expect(await postStatus(post.id)).toBeUndefined();
        expectGone(post);
      }
      expectKept(removed);
      expect(storage.getPublicObject(thumb)).toBeUndefined();
      expect(storage.getPublicObject(display)).toBeUndefined();

      // A profile created again starts empty: no avatar, no old post.
      const revived = await request(app.getHttpServer())
        .post('/masters')
        .set('authorization', `Bearer ${master.token}`)
        .send({ displayName: 'Usta Kamran' });
      expect(revived.status).toBe(200);
      expect(revived.body as Master).toMatchObject({ avatarUrl: null, avatarLargeUrl: null });
      await pool.query(`update masters set verification_status = 'active' where id = $1`, [
        master.masterId,
      ]);
      const list = await request(app.getHttpServer())
        .get('/masters/me/portfolio/posts')
        .set('authorization', `Bearer ${master.token}`);
      expect((list.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
        removed.id,
      ]);
    });

    it('is finished by the sweep when the job is lost', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'published');
      const deleted = await request(app.getHttpServer())
        .delete('/masters/me')
        .set('authorization', `Bearer ${master.token}`);
      expect(deleted.status).toBe(204);
      // The job never runs; the post's grace passes.
      await pool.query(
        `update portfolio_posts set updated_at = now() - interval '1 hour' where id = $1`,
        [post.id],
      );

      await cleanup.sweep();

      expect(await postStatus(post.id)).toBeUndefined();
      expectGone(post);
    });

    it('never takes the avatar of a master who simply creates their profile again', async () => {
      const master = await seedMaster();
      const token = randomUUID();
      const thumb = `avatars/${token}/thumb.webp`;
      const display = `avatars/${token}/display.webp`;
      await pool.query(
        `insert into master_avatar_uploads (id, master_id, raw_storage_key, declared_content_type,
                                            verified_content_type, raw_size_bytes, status,
                                            presign_expires_at, thumb_key, display_key, updated_at)
         values (gen_random_uuid(), $1, 'avatar-incoming/' || gen_random_uuid(), 'image/jpeg', 'image/jpeg',
                 1000, 'ready', now(), $2, $3, now() - interval '1 hour')`,
        [master.masterId, thumb, display],
      );
      await pool.query(
        `update masters set avatar_thumb_key = $2, avatar_display_key = $3 where id = $1`,
        [master.masterId, thumb, display],
      );
      await putRendition(thumb);
      await putRendition(display);

      const again = await request(app.getHttpServer())
        .post('/masters')
        .set('authorization', `Bearer ${master.token}`)
        .send({ displayName: 'Usta Kamran' });
      expect(again.status).toBe(200);
      expect((again.body as Master).avatarUrl).not.toBeNull();

      await cleanup.sweep();
      expect(storage.getPublicObject(thumb)).toBeDefined();
      expect(storage.getPublicObject(display)).toBeDefined();
    });
  });

  describe('what the sweep leaves alone, and how it survives a failure', () => {
    it('keeps a suspended master’s old drafts — suspension keeps everything', async () => {
      const master = await seedMaster();
      const draft = await seedPost(master, 'draft', 200);
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [master.masterId],
      );

      await cleanup.sweep();

      expect(await postStatus(draft.id)).toBe('draft');
      expectKept(draft);
    });

    it('does not fail a draft’s stuck photo: publishing enqueues it again', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'draft');
      await pool.query(
        `update portfolio_media
            set status = 'uploaded', thumb_key = null, display_key = null, width = null, height = null,
                bytes_total = null, updated_at = now() - interval '7 hours'
          where post_id = $1 and position = 0`,
        [post.id],
      );

      await cleanup.sweep();

      const { rows } = await pool.query<{ status: string }>(
        `select status from portfolio_media where post_id = $1 and position = 0`,
        [post.id],
      );
      expect(rows[0]?.status).toBe('uploaded');
    });

    it('deletes a deleted post’s reserved keys too, and waits for a photo still being worked on', async () => {
      const master = await seedMaster();
      const post = await seedPost(master, 'deleted', 1);
      // One photo still processing, its keys reserved, touched a minute ago.
      await pool.query(
        `update portfolio_media
            set status = 'processing', width = null, height = null, bytes_total = null,
                updated_at = now() - interval '1 minute'
          where post_id = $1 and position = 0`,
        [post.id],
      );

      expect(await cleanup.deletePost(post.id)).toBe(false);
      expectGone(post);
      expect(await postStatus(post.id)).toBe('deleted');

      // The job is done or dead: the rows go.
      await pool.query(
        `update portfolio_media set updated_at = now() - interval '1 hour' where post_id = $1`,
        [post.id],
      );
      expect(await cleanup.deletePost(post.id)).toBe(true);
    });

    it('carries on past an item storage refuses, and finishes it on the next run', async () => {
      const master = await seedMaster();
      const first = await seedPost(master, 'deleted', 3);
      const second = await seedPost(master, 'deleted', 2);
      const deletePublic = storage.deletePublic.bind(storage);
      let refused = false;
      storage.deletePublic = (keys) => {
        if (!refused && keys.some((key) => first.publicKeys.includes(key))) {
          refused = true;
          return Promise.reject(new Error('storage unavailable'));
        }
        return deletePublic(keys);
      };
      try {
        await cleanup.sweep();
      } finally {
        storage.deletePublic = deletePublic;
      }

      expect(await postStatus(first.id)).toBe('deleted');
      expectKept(first);
      expect(await postStatus(second.id)).toBeUndefined();

      await cleanup.sweep();
      expect(await postStatus(first.id)).toBeUndefined();
      expectGone(first);
    });

    it('never deletes an avatar upload still in flight, though its keys are reserved', async () => {
      const master = await seedMaster();
      const token = randomUUID();
      const thumb = `avatars/${token}/thumb.webp`;
      await pool.query(
        `insert into master_avatar_uploads (id, master_id, raw_storage_key, declared_content_type,
                                            verified_content_type, raw_size_bytes, status,
                                            presign_expires_at, thumb_key, display_key, updated_at)
         values (gen_random_uuid(), $1, 'avatar-incoming/' || gen_random_uuid(), 'image/jpeg', 'image/jpeg',
                 1000, 'processing', now(), $2, $3, now() - interval '1 hour')`,
        [master.masterId, thumb, `avatars/${token}/display.webp`],
      );
      await putRendition(thumb);

      await cleanup.sweep();

      expect(storage.getPublicObject(thumb)).toBeDefined();
    });
  });
});
