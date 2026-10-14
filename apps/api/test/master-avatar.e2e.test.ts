import { randomUUID } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Master, MasterAvatarPresign, MasterAvatarUpload } from '@tezusta/types';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { loadAppConfig } from '../src/infra/config/load-app-config';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MediaPipelineService } from '../src/infra/media/media-pipeline.service';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { MEDIA_QUEUE } from '../src/infra/queue/queue.constants';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { createRateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { CDN_PURGER } from '../src/infra/cdn/cdn-purger.types';
import type { StubCdnPurger } from '../src/infra/cdn/stub-cdn-purger';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  AVATAR_PURPOSE,
  DELETE_AVATAR_RENDITIONS_JOB,
  MasterAvatarService,
  avatarCleanupJobId,
} from '../src/modules/masters/master-avatar.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { geotaggedTwelveMegapixelJpeg, solidImage } from './support/image-fixtures';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/** Every test here renders photos with `sharp`: CPU work, a ceiling of its own (#356). */
const IMAGE_TEST_TIMEOUT_MS = 30_000;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

interface Party {
  readonly userId: string;
  readonly token: string;
}

interface SeededMaster extends Party {
  readonly masterId: string;
}

/**
 * A master's avatar over HTTP (#309). As in `portfolio.e2e.test.ts`, the
 * `media` worker is off and each job is run by hand through the real
 * pipeline, so a replacement and a removal can be stepped through in order.
 */
describe('master avatar (issue #309)', { timeout: IMAGE_TEST_TIMEOUT_MS }, () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let storage: StubStorageProvider;
  let pipeline: MediaPipelineService;
  let mediaQueue: Queue;
  let purger: StubCdnPurger;
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
      delete: (path: string) => auth(server().delete(path)),
    };
  }

  async function signIn(): Promise<Party> {
    const created = await app.get(UsersRepository).create({ phoneE164: nextPhone(), roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, token: pair.accessToken };
  }

  async function seedMaster(): Promise<SeededMaster> {
    const party = await signIn();
    const created = await as(party.token).post('/masters', { displayName: 'Usta Elçin' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [masterId]);
    return { ...party, masterId };
  }

  function code(res: request.Response): string {
    return (res.body as ErrorEnvelope).error.code;
  }

  function rawKeyOf(presign: MasterAvatarPresign): string {
    return decodeURIComponent(presign.uploadUrl.slice('stub://upload/'.length));
  }

  async function presign(master: Party, contentType = 'image/jpeg'): Promise<MasterAvatarPresign> {
    const res = await as(master.token).post('/masters/me/avatar/presign', { contentType });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as MasterAvatarPresign;
  }

  async function upload(master: Party, bytes: Buffer): Promise<string> {
    const slot = await presign(master);
    storage.putObject(rawKeyOf(slot), new Uint8Array(bytes), 'image/jpeg');
    const res = await as(master.token).post(`/masters/me/avatar/${slot.uploadId}/confirm`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return slot.uploadId;
  }

  async function runJob(uploadId: string): Promise<void> {
    await pipeline.run({ purpose: AVATAR_PURPOSE, itemId: uploadId });
  }

  /** What the `media` worker would do with a cleanup job. */
  async function runCleanup(uploadId: string): Promise<void> {
    await app.get(DeferredJobHandlerRegistry).resolve(DELETE_AVATAR_RENDITIONS_JOB)({ uploadId });
  }

  async function me(master: Party): Promise<Master> {
    const res = await as(master.token).get('/masters/me');
    expect(res.status).toBe(200);
    return res.body as Master;
  }

  function keyOf(url: string | null): string {
    if (url === null) {
      throw new Error('expected a URL');
    }
    return new URL(url).pathname.slice(1);
  }

  async function uploadKeys(uploadId: string): Promise<{ thumb: string; display: string }> {
    const { rows } = await pool.query<{ thumb_key: string; display_key: string }>(
      `select thumb_key, display_key from master_avatar_uploads where id = $1`,
      [uploadId],
    );
    return { thumb: rows[0]?.thumb_key ?? '', display: rows[0]?.display_key ?? '' };
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);
    set('MEDIA_WORKER_MODE', 'off');
    set('PORTFOLIO_IMAGE_MAX_BYTES', String(IMAGE_MAX_BYTES));

    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `avatar-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'portfolio-upload': {
          ...real.policies['portfolio-upload'],
          perIdentifier: 1_000_000,
          perIp: 1_000_000,
        },
        'portfolio-write': {
          ...real.policies['portfolio-write'],
          perIdentifier: 1_000_000,
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
    // Bound once, as `master-offers.e2e.test.ts` explains.
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
    purger = app.get<StubCdnPurger>(CDN_PURGER);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
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

  it('sets an avatar: two square WebPs with no EXIF, carried on GET /masters/me', async () => {
    const master = await seedMaster();
    expect(await me(master)).toMatchObject({ avatarUrl: null, avatarLargeUrl: null });

    const uploadId = await upload(master, await geotaggedTwelveMegapixelJpeg());
    expect(await mediaQueue.getJob(`${AVATAR_PURPOSE}-${uploadId}`)).toBeDefined();
    const pending = await as(master.token).get(`/masters/me/avatar/${uploadId}`);
    expect(pending.body as MasterAvatarUpload).toEqual({
      uploadId,
      status: 'uploaded',
      failureCode: null,
    });

    await runJob(uploadId);

    const profile = await me(master);
    expect(profile.avatarUrl).toMatch(/^https:\/\/.+\/avatars\/[0-9a-f]{32}\/thumb\.webp$/);
    expect(profile.avatarLargeUrl).toMatch(/^https:\/\/.+\/avatars\/[0-9a-f]{32}\/display\.webp$/);
    for (const [url, side] of [
      [profile.avatarUrl, 128],
      [profile.avatarLargeUrl, 512],
    ] as const) {
      const object = storage.getPublicObject(keyOf(url));
      expect(object?.cacheControl).toBe('public, max-age=31536000, immutable');
      const meta = await sharp(Buffer.from(object?.bytes ?? [])).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', side, side]);
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
    const done = await as(master.token).get(`/masters/me/avatar/${uploadId}`);
    expect((done.body as MasterAvatarUpload).status).toBe('ready');
  });

  it('replaces an avatar in one step, and leaves only the new renditions once the cleanup runs', async () => {
    const master = await seedMaster();
    const first = await upload(master, await solidImage('jpeg', 800, 600));
    await runJob(first);
    const old = await uploadKeys(first);

    const second = await upload(master, await solidImage('jpeg', 600, 800));
    // Until the new one is ready, the old avatar is still the avatar.
    expect(keyOf((await me(master)).avatarUrl)).toBe(old.thumb);
    await runJob(second);

    const replaced = await me(master);
    const fresh = await uploadKeys(second);
    expect(keyOf(replaced.avatarUrl)).toBe(fresh.thumb);
    expect(keyOf(replaced.avatarLargeUrl)).toBe(fresh.display);
    expect(await mediaQueue.getJob(avatarCleanupJobId(first, 'replaced'))).toBeDefined();

    await runCleanup(first);
    expect(purger.purged()).toEqual(
      expect.arrayContaining([storage.publicUrl(old.thumb), storage.publicUrl(old.display)]),
    );
    expect(purger.purged()).not.toContain(storage.publicUrl(fresh.thumb));
    expect(storage.getPublicObject(old.thumb)).toBeUndefined();
    expect(storage.getPublicObject(old.display)).toBeUndefined();
    expect(storage.getPublicObject(fresh.thumb)).toBeDefined();
    expect(storage.getPublicObject(fresh.display)).toBeDefined();
    const { rows } = await pool.query<{ renditions_deleted_at: Date | null }>(
      `select renditions_deleted_at from master_avatar_uploads where id = $1`,
      [first],
    );
    expect(rows[0]?.renditions_deleted_at).not.toBeNull();

    // The cleanup never deletes the current avatar, however often it runs.
    await runCleanup(second);
    expect(storage.getPublicObject(fresh.thumb)).toBeDefined();
  });

  it('removes the avatar, idempotently, and its renditions with it', async () => {
    const master = await seedMaster();
    const uploadId = await upload(master, await solidImage('jpeg', 400, 400));
    await runJob(uploadId);
    const keys = await uploadKeys(uploadId);

    expect((await as(master.token).delete('/masters/me/avatar')).status).toBe(204);
    expect(await me(master)).toMatchObject({ avatarUrl: null, avatarLargeUrl: null });
    expect((await as(master.token).delete('/masters/me/avatar')).status).toBe(204);
    expect(await mediaQueue.getJob(avatarCleanupJobId(uploadId, 'removed'))).toBeDefined();

    await runCleanup(uploadId);
    expect(storage.getPublicObject(keys.thumb)).toBeUndefined();
    expect(storage.getPublicObject(keys.display)).toBeUndefined();
    expect(purger.purged()).toEqual(
      expect.arrayContaining([storage.publicUrl(keys.thumb), storage.publicUrl(keys.display)]),
    );
  });

  it('cancels an upload not yet claimed when the avatar is removed, so it does not come back', async () => {
    const master = await seedMaster();
    const uploadId = await upload(master, await solidImage('jpeg', 400, 400));

    expect((await as(master.token).delete('/masters/me/avatar')).status).toBe(204);
    await runJob(uploadId);

    expect(await me(master)).toMatchObject({ avatarUrl: null });
    const status = await as(master.token).get(`/masters/me/avatar/${uploadId}`);
    expect(status.body as MasterAvatarUpload).toMatchObject({
      status: 'failed',
      failureCode: 'cancelled',
    });
  });

  it('discards an upload already processing when the avatar is removed, and cleans it up', async () => {
    const master = await seedMaster();
    const uploadId = await upload(master, await solidImage('jpeg', 400, 400));
    const service = app.get(MasterAvatarService);
    const keys = {
      thumb: `avatars/${randomUUID()}/thumb.webp`,
      display: `avatars/${randomUUID()}/display.webp`,
    };

    expect(await service.load(uploadId)).toBeDefined();
    await service.reserveKeys(uploadId, keys);
    expect((await as(master.token).delete('/masters/me/avatar')).status).toBe(204);
    const outcome = await service.complete(uploadId, [
      { name: 'thumb', key: keys.thumb, width: 128, height: 128, bytes: 10 },
      { name: 'display', key: keys.display, width: 512, height: 512, bytes: 20 },
    ]);

    expect(outcome).toBe('discarded');
    expect(await me(master)).toMatchObject({ avatarUrl: null, avatarLargeUrl: null });
    const status = await as(master.token).get(`/masters/me/avatar/${uploadId}`);
    expect(status.body as MasterAvatarUpload).toMatchObject({
      status: 'failed',
      failureCode: 'cancelled',
    });
    expect(await mediaQueue.getJob(avatarCleanupJobId(uploadId, 'discarded'))).toBeDefined();
  });

  it('gives a deleted master no avatar, and discards the upload that finished after', async () => {
    const master = await seedMaster();
    const uploadId = await upload(master, await solidImage('jpeg', 400, 400));
    const service = app.get(MasterAvatarService);
    expect(await service.load(uploadId)).toBeDefined();
    await pool.query(`update masters set deleted_at = now() where id = $1`, [master.masterId]);

    const outcome = await service.complete(uploadId, [
      {
        name: 'thumb',
        key: `avatars/${randomUUID()}/thumb.webp`,
        width: 128,
        height: 128,
        bytes: 10,
      },
      {
        name: 'display',
        key: `avatars/${randomUUID()}/display.webp`,
        width: 512,
        height: 512,
        bytes: 20,
      },
    ]);

    expect(outcome).toBe('discarded');
    const { rows } = await pool.query<{ avatar_thumb_key: string | null }>(
      `select avatar_thumb_key from masters where id = $1`,
      [master.masterId],
    );
    expect(rows[0]?.avatar_thumb_key).toBeNull();
  });

  it('replaces a presign never uploaded, and refuses a second while one is processing', async () => {
    const master = await seedMaster();
    const abandoned = await presign(master);
    storage.putObject(rawKeyOf(abandoned), new Uint8Array([1]), 'image/jpeg');
    const next = await presign(master);
    expect(storage.hasObject(rawKeyOf(abandoned))).toBe(false);

    storage.putObject(
      rawKeyOf(next),
      new Uint8Array(await solidImage('jpeg', 300, 300)),
      'image/jpeg',
    );
    await as(master.token).post(`/masters/me/avatar/${next.uploadId}/confirm`);
    const busy = await as(master.token).post('/masters/me/avatar/presign', {
      contentType: 'image/jpeg',
    });
    expect(busy.status).toBe(409);
    expect(code(busy)).toBe('AVATAR_UPLOAD_IN_PROGRESS');
  });

  it('marks an upload the decoder refuses failed, and keeps the avatar it had', async () => {
    const master = await seedMaster();
    const good = await upload(master, await solidImage('jpeg', 300, 300));
    await runJob(good);
    const before = (await me(master)).avatarUrl;

    const whole = await solidImage('jpeg', 800, 600);
    const broken = await upload(master, whole.subarray(0, Math.floor(whole.byteLength * 0.6)));
    await expect(runJob(broken)).rejects.toThrow();

    const status = await as(master.token).get(`/masters/me/avatar/${broken}`);
    expect(status.body as MasterAvatarUpload).toMatchObject({
      status: 'failed',
      failureCode: 'undecodable',
    });
    expect((await me(master)).avatarUrl).toBe(before);
  });

  describe('refusals', () => {
    it.each([
      [
        'a JPEG presigned as a PNG',
        'image/png',
        () => solidImage('jpeg', 100, 100),
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
      [
        'a photo over the size cap',
        'image/jpeg',
        () => {
          const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
          big.set([0xff, 0xd8, 0xff]);
          return Promise.resolve(big);
        },
        'PORTFOLIO_MEDIA_TOO_LARGE',
      ],
    ])(
      'refuses %s at confirm, deletes it, and keeps the upload retryable',
      async (_label, contentType, bytes, expected) => {
        const master = await seedMaster();
        const slot = await presign(master, contentType);
        storage.putObject(rawKeyOf(slot), new Uint8Array(await bytes()), contentType);

        const res = await as(master.token).post(`/masters/me/avatar/${slot.uploadId}/confirm`);
        expect(res.status).toBe(422);
        expect(code(res)).toBe(expected);
        expect(storage.hasObject(rawKeyOf(slot))).toBe(false);
        const status = await as(master.token).get(`/masters/me/avatar/${slot.uploadId}`);
        expect((status.body as MasterAvatarUpload).status).toBe('awaiting_upload');
      },
    );

    it('validates every input', async () => {
      const master = await seedMaster();
      const cases: [string, request.Test][] = [
        [
          'a video',
          as(master.token).post('/masters/me/avatar/presign', { contentType: 'video/mp4' }),
        ],
        ['no content type', as(master.token).post('/masters/me/avatar/presign', {})],
        [
          'an unknown field',
          as(master.token).post('/masters/me/avatar/presign', {
            contentType: 'image/jpeg',
            fit: 'cover',
          }),
        ],
        ['an upload id not a uuid', as(master.token).post('/masters/me/avatar/nope/confirm')],
        ['a status id not a uuid', as(master.token).get('/masters/me/avatar/nope')],
      ];
      for (const [label, pending] of cases) {
        const res = await pending;
        expect(res.status, label).toBe(422);
      }
    });

    it('answers a confirm before the upload, and a second confirm, with their own codes', async () => {
      const master = await seedMaster();
      const slot = await presign(master);
      const confirm = `/masters/me/avatar/${slot.uploadId}/confirm`;
      expect(code(await as(master.token).post(confirm))).toBe('PORTFOLIO_MEDIA_NOT_UPLOADED');
      storage.putObject(
        rawKeyOf(slot),
        new Uint8Array(await solidImage('jpeg', 100, 100)),
        'image/jpeg',
      );
      expect((await as(master.token).post(confirm)).status).toBe(200);
      expect(code(await as(master.token).post(confirm))).toBe('PORTFOLIO_MEDIA_ALREADY_CONFIRMED');
    });
  });

  describe('who may', () => {
    it('refuses a customer and a suspended master on every write, with a stable 403', async () => {
      const customer = await signIn();
      expect((await as(customer.token).post('/customers', { displayName: 'Aysel' })).status).toBe(
        201,
      );
      const suspended = await seedMaster();
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [suspended.masterId],
      );

      for (const party of [customer, suspended]) {
        const writes = [
          await as(party.token).post('/masters/me/avatar/presign', { contentType: 'image/jpeg' }),
          await as(party.token).post(`/masters/me/avatar/${randomUUID()}/confirm`),
          await as(party.token).delete('/masters/me/avatar'),
        ];
        for (const res of writes) {
          expect(res.status).toBe(403);
          expect(code(res)).toBe('PORTFOLIO_MASTER_NOT_ACTIVE');
        }
      }
    });

    it('never touches another master’s avatar or uploads', async () => {
      const owner = await seedMaster();
      const uploadId = await upload(owner, await solidImage('jpeg', 300, 300));
      await runJob(uploadId);
      const stranger = await seedMaster();

      expect((await as(stranger.token).get(`/masters/me/avatar/${uploadId}`)).status).toBe(404);
      expect((await as(stranger.token).post(`/masters/me/avatar/${uploadId}/confirm`)).status).toBe(
        404,
      );
      expect((await as(stranger.token).delete('/masters/me/avatar')).status).toBe(204);
      expect((await me(owner)).avatarUrl).not.toBeNull();
    });

    it('answers an admin token and no token 401', async () => {
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['super_admin'],
      });
      const token = (await app.get(AdminSessionService).start(admin.id)).accessToken;
      for (const auth of [token, undefined]) {
        expect(
          (await as(auth).post('/masters/me/avatar/presign', { contentType: 'image/jpeg' })).status,
        ).toBe(401);
        expect((await as(auth).delete('/masters/me/avatar')).status).toBe(401);
      }
    });
  });
});
