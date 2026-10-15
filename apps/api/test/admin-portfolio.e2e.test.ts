import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminPortfolioPost,
  AdminPortfolioPostDetail,
  AdminRole,
  CursorPage,
  OwnPortfolioPost,
} from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { CDN_PURGER } from '../src/infra/cdn/cdn-purger.types';
import type { StubCdnPurger } from '../src/infra/cdn/stub-cdn-purger';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MEDIA_QUEUE } from '../src/infra/queue/queue.constants';
import { PUBLIC_MEDIA_CACHE_CONTROL, STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { avatarCleanupJobId } from '../src/modules/masters/master-avatar.service';
import { PortfolioCleanupService } from '../src/modules/portfolio/portfolio-cleanup.service';
import {
  evidenceMoveJobId,
  PortfolioModerationService,
} from '../src/modules/portfolio/portfolio-moderation.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99453${String(phoneCounter).padStart(7, '0')}`;
}

interface Master {
  readonly masterId: string;
  readonly token: string;
}

interface Post {
  readonly id: string;
  readonly keys: string[];
}

/**
 * Portfolio moderation over HTTP (#312, ADR-0045 § 6, § 8): who may, what a
 * removal hides and keeps, what the audit records, and how the evidence moves
 * and is purged.
 */
describe('admin portfolio moderation (issue #312)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let storage: StubStorageProvider;
  let purger: StubCdnPurger;
  let mediaQueue: Queue;
  let fileDir: string;
  let renditionFile: string;
  const tokens = new Map<AdminRole, { id: string; token: string }>();
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
      get: (url: string) => auth(server().get(url)),
      post: (url: string, body: object = {}) => auth(server().post(url)).send(body),
    };
  }

  function admin(role: AdminRole): string {
    const entry = tokens.get(role);
    if (entry === undefined) {
      throw new Error(`no ${role} token`);
    }
    return entry.token;
  }

  function code(res: request.Response): string {
    return (res.body as ErrorEnvelope).error.code;
  }

  async function seedMaster(name = 'Usta Fərid'): Promise<Master> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const res = await request(app.getHttpServer())
      .post('/masters')
      .set('authorization', `Bearer ${pair.accessToken}`)
      .send({ displayName: name });
    expect(res.status).toBe(201);
    const masterId = (res.body as { id: string }).id;
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [masterId]);
    return { masterId, token: pair.accessToken };
  }

  async function putRendition(key: string): Promise<void> {
    await storage.putPublic({
      key,
      filePath: renditionFile,
      contentType: 'image/webp',
      cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
    });
  }

  /** A post with one ready photo whose renditions are in the public bucket. */
  async function seedPost(
    master: Master,
    status: 'draft' | 'published' = 'published',
    createdAt = new Date(),
  ): Promise<Post> {
    const id = randomUUID();
    await pool.query(
      `insert into portfolio_posts (id, master_id, status, media_count, caption, published_at, created_at)
       values ($1, $2, $3::portfolio_post_status, 1, 'Mətbəx',
               case when $3::text = 'published' then $4::timestamptz end, $4::timestamptz)`,
      [id, master.masterId, status, createdAt.toISOString()],
    );
    const token = randomUUID();
    const keys = [`portfolio/${token}/thumb.webp`, `portfolio/${token}/display.webp`];
    await pool.query(
      `insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                    verified_content_type, raw_size_bytes, status, presign_expires_at,
                                    thumb_key, display_key, width, height, bytes_total)
       values (gen_random_uuid(), $1, 0, 'portfolio-incoming/' || gen_random_uuid(), 'image/jpeg',
               'image/jpeg', 1000, 'ready', now(), $2, $3, 1440, 1080, 3000)`,
      [id, keys[0], keys[1]],
    );
    for (const key of keys) {
      await putRendition(key);
    }
    return { id, keys };
  }

  async function auditFor(targetId: string, action: string) {
    const { rows } = await pool.query<{
      admin_user_id: string;
      reason: string | null;
      before: unknown;
      after: unknown;
    }>(
      `select admin_user_id, reason, before, after from admin_audit_log
        where target_id = $1 and action = $2`,
      [targetId, action],
    );
    return rows;
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
    mediaQueue = app.get<Queue>(getQueueToken(MEDIA_QUEUE));
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    fileDir = await mkdtemp(path.join(tmpdir(), 'admin-portfolio-'));
    renditionFile = path.join(fileDir, 'rendition.webp');
    await writeFile(renditionFile, 'webp');

    for (const role of ['support', 'moderator', 'finance', 'super_admin'] as const) {
      const created = await app.get(AdminRepository).createAdmin({
        email: `${role}-${randomUUID()}@tezusta.az`,
        displayName: role,
        roles: [role],
      });
      tokens.set(role, {
        id: created.id,
        token: (await app.get(AdminSessionService).start(created.id)).accessToken,
      });
    }
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

  describe('who may', () => {
    function endpoints(postId: string, masterId: string) {
      return [
        (token?: string) => as(token).get('/admin/portfolio/posts'),
        (token?: string) => as(token).get(`/admin/portfolio/posts/${postId}`),
        (token?: string) =>
          as(token).post(`/admin/portfolio/posts/${postId}/removal`, { reason: 'Qayda' }),
        (token?: string) =>
          as(token).post(`/admin/masters/${masterId}/avatar/removal`, { reason: 'Qayda' }),
      ];
    }

    it('answers 401 without a token, and with a customer’s token', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      for (const call of endpoints(post.id, master.masterId)) {
        expect((await call()).status).toBe(401);
        expect((await call(master.token)).status).toBe(401);
      }
    });

    it.each(['support', 'finance'] as const)('refuses %s 403 on every endpoint', async (role) => {
      const master = await seedMaster();
      const post = await seedPost(master);
      for (const call of endpoints(post.id, master.masterId)) {
        const res = await call(admin(role));
        expect(res.status).toBe(403);
      }
      expect(await auditFor(post.id, 'portfolio_post.remove')).toHaveLength(0);
    });

    it.each(['moderator', 'super_admin'] as const)('lets %s list and read', async (role) => {
      const master = await seedMaster();
      const post = await seedPost(master);
      expect((await as(admin(role)).get('/admin/portfolio/posts')).status).toBe(200);
      expect((await as(admin(role)).get(`/admin/portfolio/posts/${post.id}`)).status).toBe(200);
    });
  });

  describe('listing and reading', () => {
    it('filters by master, status and dates, newest first, a page at a time', async () => {
      const master = await seedMaster('Usta Siyahı');
      const old = await seedPost(master, 'published', new Date('2026-01-10T10:00:00Z'));
      const draft = await seedPost(master, 'draft', new Date('2026-02-10T10:00:00Z'));
      const recent = await seedPost(master, 'published', new Date('2026-03-10T10:00:00Z'));
      const other = await seedMaster();
      await seedPost(other);
      const base = `/admin/portfolio/posts?masterId=${master.masterId}`;
      const moderator = admin('moderator');

      const all = (await as(moderator).get(base)).body as CursorPage<AdminPortfolioPost>;
      expect(all.items.map((item) => item.id)).toEqual([recent.id, draft.id, old.id]);
      expect(all.items[0]).toMatchObject({
        masterId: master.masterId,
        masterName: 'Usta Siyahı',
        masterStatus: 'active',
        status: 'published',
        evidence: 'none',
      });

      const drafts = (await as(moderator).get(`${base}&status=draft`))
        .body as CursorPage<AdminPortfolioPost>;
      expect(drafts.items.map((item) => item.id)).toEqual([draft.id]);

      const window = (
        await as(moderator).get(`${base}&from=2026-02-01T00:00:00Z&to=2026-03-01T00:00:00Z`)
      ).body as CursorPage<AdminPortfolioPost>;
      expect(window.items.map((item) => item.id)).toEqual([draft.id]);

      const first = (await as(moderator).get(`${base}&limit=2`))
        .body as CursorPage<AdminPortfolioPost>;
      expect(first.items).toHaveLength(2);
      const second = (
        await as(moderator).get(
          `${base}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        )
      ).body as CursorPage<AdminPortfolioPost>;
      expect(second.items.map((item) => item.id)).toEqual([old.id]);
      expect(second.nextCursor).toBeNull();
    });

    it('lists only shown posts as published, and removed ones as removed', async () => {
      const master = await seedMaster();
      const shown = await seedPost(master);
      const removed = await seedPost(master);
      await as(admin('moderator')).post(`/admin/portfolio/posts/${removed.id}/removal`, {
        reason: 'Qayda',
      });
      const base = `/admin/portfolio/posts?masterId=${master.masterId}`;
      const ids = async (query: string) =>
        (
          (await as(admin('moderator')).get(`${base}&${query}`))
            .body as CursorPage<AdminPortfolioPost>
        ).items.map((item) => item.id);
      expect(await ids('status=published')).toEqual([shown.id]);
      expect(await ids('status=removed')).toEqual([removed.id]);
    });

    it('resumes after the last post of a page even once that post is gone', async () => {
      const master = await seedMaster();
      // Three posts in one millisecond: only the microseconds tell them apart.
      const ids: string[] = [];
      for (const micros of ['300', '200', '100']) {
        const post = await seedPost(master, 'draft');
        await pool.query(`update portfolio_posts set created_at = $2::timestamptz where id = $1`, [
          post.id,
          `2026-04-01T10:00:00.000${micros}Z`,
        ]);
        ids.push(post.id);
      }
      const base = `/admin/portfolio/posts?masterId=${master.masterId}&limit=1`;
      const page = async (cursor: string | null) =>
        (
          await as(admin('moderator')).get(
            cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`,
          )
        ).body as CursorPage<AdminPortfolioPost>;

      const first = await page(null);
      expect(first.items.map((item) => item.id)).toEqual([ids[0]]);
      // The post is hard-deleted between the pages, as a deleted draft is.
      await pool.query('delete from portfolio_media where post_id = $1', [ids[0]]);
      await pool.query('delete from portfolio_posts where id = $1', [ids[0]]);

      const second = await page(first.nextCursor);
      expect(second.items.map((item) => item.id)).toEqual([ids[1]]);
      const third = await page(second.nextCursor);
      expect(third.items.map((item) => item.id)).toEqual([ids[2]]);
      expect(third.nextCursor).toBeNull();
    });

    it('validates the query', async () => {
      for (const query of [
        'status=hidden',
        'limit=101',
        'masterId=nope',
        'from=2026-03-01T00:00:00Z&to=2026-02-01T00:00:00Z',
        'unknown=1',
      ]) {
        const res = await as(admin('moderator')).get(`/admin/portfolio/posts?${query}`);
        expect(res.status, query).toBe(422);
      }
      expect((await as(admin('moderator')).get('/admin/portfolio/posts/nope')).status).toBe(422);
      expect(
        (await as(admin('moderator')).get(`/admin/portfolio/posts/${randomUUID()}`)).status,
      ).toBe(404);
    });

    it('reads a live post’s photos by their public URLs', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      const detail = (await as(admin('moderator')).get(`/admin/portfolio/posts/${post.id}`))
        .body as AdminPortfolioPostDetail;
      expect(detail.media).toHaveLength(1);
      expect(detail.media[0]?.thumbUrl).toBe(storage.publicUrl(post.keys[0] ?? ''));
      expect(detail.media[0]?.displayUrl).toBe(storage.publicUrl(post.keys[1] ?? ''));
    });
  });

  describe('removing a post', () => {
    it('hides it at once, audits who and why, and keeps its photos privately as evidence', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      const moderator = tokens.get('moderator');

      const res = await as(moderator?.token).post(`/admin/portfolio/posts/${post.id}/removal`, {
        reason: '  Ev nömrəsi görünür  ',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'published',
        removalReason: 'Ev nömrəsi görünür',
        removedByAdminId: moderator?.id,
        evidence: 'pending_move',
      });
      // The move is the media queue's, not the request's.
      expect(await mediaQueue.getJob(evidenceMoveJobId(post.id))).toBeDefined();
      await app.get(PortfolioModerationService).moveEvidence(post.id);

      const removed = (await as(moderator?.token).get(`/admin/portfolio/posts/${post.id}`))
        .body as AdminPortfolioPostDetail;
      expect(removed.evidence).toBe('kept');
      // The public objects are gone and purged; the evidence is private.
      for (const key of post.keys) {
        expect(storage.getPublicObject(key)).toBeUndefined();
        expect(storage.hasObject(`portfolio-evidence/${key}`)).toBe(true);
      }
      expect(purger.purged()).toEqual(
        expect.arrayContaining(post.keys.map((key) => storage.publicUrl(key))),
      );
      // A moderator reads the evidence through presigned URLs.
      expect(removed.media[0]?.thumbUrl).toContain(
        encodeURIComponent(`portfolio-evidence/${post.keys[0] ?? ''}`),
      );

      const [audit] = await auditFor(post.id, 'portfolio_post.remove');
      expect(audit).toMatchObject({
        admin_user_id: moderator?.id,
        reason: 'Ev nömrəsi görünür',
        before: { removed: false, status: 'published', masterId: master.masterId },
        after: { removed: true, status: 'published', masterId: master.masterId },
      });

      // The master sees it removed, without photos.
      const own = (
        await request(app.getHttpServer())
          .get(`/masters/me/portfolio/posts/${post.id}`)
          .set('authorization', `Bearer ${master.token}`)
      ).body as OwnPortfolioPost;
      expect(own.removedAt).not.toBeNull();
      expect(own.media[0]).toMatchObject({ thumbUrl: null, displayUrl: null });

      // Nobody else sees it: the public feed leaves it out.
      const feed = await request(app.getHttpServer())
        .get(`/masters/${master.masterId}/portfolio`)
        .set('authorization', `Bearer ${master.token}`);
      expect((feed.body as CursorPage<{ id: string }>).items).toEqual([]);
    });

    it('refuses a removal without a reason, or with one too long', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      for (const body of [
        {},
        { reason: '' },
        { reason: '   ' },
        { reason: 'x'.repeat(601) },
        { reason: 'ok', extra: 1 },
      ]) {
        const res = await as(admin('moderator')).post(
          `/admin/portfolio/posts/${post.id}/removal`,
          body,
        );
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(await auditFor(post.id, 'portfolio_post.remove')).toHaveLength(0);
    });

    it('refuses a second removal, a draft, and a post that does not exist, each with its own answer', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      const draft = await seedPost(master, 'draft');
      const url = (id: string) => `/admin/portfolio/posts/${id}/removal`;
      const moderator = admin('moderator');

      expect((await as(moderator).post(url(post.id), { reason: 'Birinci' })).status).toBe(200);
      const again = await as(moderator).post(url(post.id), { reason: 'İkinci' });
      expect(again.status).toBe(409);
      expect(code(again)).toBe('PORTFOLIO_POST_ALREADY_REMOVED');
      const notShown = await as(moderator).post(url(draft.id), { reason: 'x' });
      expect(code(notShown)).toBe('PORTFOLIO_POST_NOT_REMOVABLE');
      expect((notShown.body as ErrorEnvelope).error.details).toEqual({ status: 'draft' });
      expect((await as(moderator).post(url(randomUUID()), { reason: 'x' })).status).toBe(404);
      expect(await auditFor(post.id, 'portfolio_post.remove')).toHaveLength(1);
    });

    it('writes the removal and its audit row together, or neither', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      const spy = vi
        .spyOn(app.get(AdminRepository), 'appendAudit')
        .mockRejectedValueOnce(new Error('audit store unavailable'));
      try {
        const res = await as(admin('moderator')).post(`/admin/portfolio/posts/${post.id}/removal`, {
          reason: 'Qayda',
        });
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const { rows } = await pool.query<{ removed_at: Date | null }>(
        `select removed_at from portfolio_posts where id = $1`,
        [post.id],
      );
      expect(rows[0]?.removed_at).toBeNull();
      expectKeptPublic(post);
    });

    function expectKeptPublic(post: Post): void {
      for (const key of post.keys) {
        expect(storage.getPublicObject(key)).toBeDefined();
      }
    }

    it('leaves a fresh removal to its job, and moves the evidence of one the job did not', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      const res = await as(admin('moderator')).post(`/admin/portfolio/posts/${post.id}/removal`, {
        reason: 'Qayda',
      });
      expect(res.status).toBe(200);
      const evidence = async () =>
        (
          (await as(admin('moderator')).get(`/admin/portfolio/posts/${post.id}`))
            .body as AdminPortfolioPostDetail
        ).evidence;

      // Within the job's grace the sweep leaves it alone.
      await app.get(PortfolioCleanupService).sweep();
      expect(await evidence()).toBe('pending_move');
      expectKeptPublic(post);

      // Past it (the job lost, or out of attempts) the sweep moves it.
      await pool.query(
        `update portfolio_posts set removed_at = now() - interval '20 minutes' where id = $1`,
        [post.id],
      );
      await app.get(PortfolioCleanupService).sweep();
      expect(await evidence()).toBe('kept');
      for (const key of post.keys) {
        expect(storage.getPublicObject(key)).toBeUndefined();
        expect(storage.hasObject(`portfolio-evidence/${key}`)).toBe(true);
      }
    });

    it('keeps a removal whose move fails, for the job or the sweep to retry', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      await as(admin('moderator')).post(`/admin/portfolio/posts/${post.id}/removal`, {
        reason: 'Qayda',
      });
      const copy = storage.copyPublicToPrivate.bind(storage);
      storage.copyPublicToPrivate = () => Promise.reject(new Error('storage unavailable'));
      try {
        await expect(app.get(PortfolioModerationService).moveEvidence(post.id)).rejects.toThrow(
          'storage unavailable',
        );
      } finally {
        storage.copyPublicToPrivate = copy;
      }
      const detail = (await as(admin('moderator')).get(`/admin/portfolio/posts/${post.id}`))
        .body as AdminPortfolioPostDetail;
      expect(detail).toMatchObject({ evidence: 'pending_move', removalReason: 'Qayda' });
      expectKeptPublic(post);

      await app.get(PortfolioModerationService).moveEvidence(post.id);
      for (const key of post.keys) {
        expect(storage.hasObject(`portfolio-evidence/${key}`)).toBe(true);
      }
    });

    it('purges the evidence once its retention has passed, and keeps the row', async () => {
      const master = await seedMaster();
      const post = await seedPost(master);
      await as(admin('moderator')).post(`/admin/portfolio/posts/${post.id}/removal`, {
        reason: 'Qayda',
      });
      await pool.query(
        `update portfolio_posts set removed_at = now() - interval '31 days' where id = $1`,
        [post.id],
      );

      await app.get(PortfolioCleanupService).sweep();

      for (const key of post.keys) {
        expect(storage.hasObject(`portfolio-evidence/${key}`)).toBe(false);
      }
      const detail = (await as(admin('moderator')).get(`/admin/portfolio/posts/${post.id}`))
        .body as AdminPortfolioPostDetail;
      expect(detail).toMatchObject({ evidence: 'purged', removalReason: 'Qayda' });
      expect(detail.media[0]).toMatchObject({ thumbUrl: null, displayUrl: null });
    });
  });

  describe('removing an avatar', () => {
    async function withAvatar(master: Master): Promise<string> {
      const uploadId = randomUUID();
      const token = randomUUID();
      const thumb = `avatars/${token}/thumb.webp`;
      const display = `avatars/${token}/display.webp`;
      await pool.query(
        `insert into master_avatar_uploads (id, master_id, raw_storage_key, declared_content_type,
                                            verified_content_type, raw_size_bytes, status,
                                            presign_expires_at, thumb_key, display_key)
         values ($1, $2, 'avatar-incoming/' || gen_random_uuid(), 'image/jpeg', 'image/jpeg', 1000, 'ready',
                 now(), $3, $4)`,
        [uploadId, master.masterId, thumb, display],
      );
      await pool.query(
        `update masters set avatar_thumb_key = $2, avatar_display_key = $3 where id = $1`,
        [master.masterId, thumb, display],
      );
      return uploadId;
    }

    it('removes it at once with a reason, audited, and enqueues the deletion of its renditions', async () => {
      const master = await seedMaster();
      const uploadId = await withAvatar(master);
      const detailBefore = await as(admin('moderator')).get(`/admin/masters/${master.masterId}`);
      expect((detailBefore.body as { avatarUrl: string | null }).avatarUrl).not.toBeNull();

      const res = await as(admin('moderator')).post(
        `/admin/masters/${master.masterId}/avatar/removal`,
        {
          reason: 'Başqasının şəkli',
        },
      );

      expect(res.status).toBe(204);
      const me = await request(app.getHttpServer())
        .get('/masters/me')
        .set('authorization', `Bearer ${master.token}`);
      expect(me.body).toMatchObject({ avatarUrl: null, avatarLargeUrl: null });
      const [audit] = await auditFor(master.masterId, 'master_avatar.remove');
      expect(audit).toMatchObject({ reason: 'Başqasının şəkli' });
      expect(await mediaQueue.getJob(avatarCleanupJobId(uploadId, 'removed'))).toBeDefined();
    });

    it('answers a master with no avatar 409, an unknown master 404, and no reason 422', async () => {
      const master = await seedMaster();
      const url = (id: string) => `/admin/masters/${id}/avatar/removal`;
      const none = await as(admin('moderator')).post(url(master.masterId), { reason: 'x' });
      expect(none.status).toBe(409);
      expect(code(none)).toBe('MASTER_AVATAR_NOT_SET');
      expect((await as(admin('moderator')).post(url(randomUUID()), { reason: 'x' })).status).toBe(
        404,
      );
      expect((await as(admin('moderator')).post(url(master.masterId), {})).status).toBe(422);
      expect(await auditFor(master.masterId, 'master_avatar.remove')).toHaveLength(0);
    });
  });
});
