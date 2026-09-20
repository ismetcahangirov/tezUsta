import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderPhoto, OrderPhotoDownload, OrderPhotoUpload } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/orders/photos/*`, `/orders/:orderId/photos*` and
 * `/admin/orders/:orderId/photos/:photoId/download` over real HTTP, through
 * the real `AppModule` graph (issue #83) — the same construction
 * `master-verification.e2e.test.ts` uses for the identical mechanism, which
 * this file follows closely.
 *
 * The **object storage boundary** is the one thing this suite mocks, for the
 * reason `master-verification.e2e.test.ts` gives: `STORAGE_PROVIDER` defaults
 * to `stub`, so the app is wired to a real, in-process `StubStorageProvider`,
 * and `putObject` stands in for the client's PUT.
 *
 * What only this layer can prove: that a key issued to one customer cannot be
 * attached by another (404, never 403); that a key already attached cannot be
 * re-attached; that the per-order photo cap is enforced atomically against
 * `orders.photo_count`, not read-then-write; that the size cap and the
 * magic-byte sniff run against the real object at confirm; that reads are
 * visible to the owning customer, the assigned master, and an audited admin,
 * and to nobody else; and that an order is still creatable with no photos at
 * all. None of that is visible from a unit test of the service against a
 * mocked repository.
 *
 * **The assigned-master path is set up directly with SQL**, not through
 * accept. No order can reach an assigned master through the API until EPIC 7
 * ships dispatch and accept — `orders.master_id` exists and is nullable today
 * only so `orders_one_active_per_master` has a column to guard, and setting
 * it here is the same construction `admin-verification.e2e.test.ts` uses to
 * put a master into an arbitrary verification status before exercising the
 * endpoint actually under test. What this suite proves is that the
 * *authorization check* is correct once a master is assigned — not that
 * dispatch can assign one, which is a different Epic's test to own.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid but never-issued uuid — well-formed, guaranteed absent. */
function unknownUuid(): string {
  return randomUUID();
}

/** Copied from `master-verification.e2e.test.ts` — see that file for the reasoning. */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

/**
 * Real rate limits are shared, via Redis, across every run on this machine.
 * `presign` carries this module's only `@RateLimit` (the `document-upload`
 * policy, shared with master verification uploads); overriding every policy
 * to an unreachable number under a fresh per-run key is the same escape hatch
 * `master-verification.e2e.test.ts` takes, for the same reason — the limit
 * itself is somebody else's test to own.
 */
const UNREACHABLE = 1_000_000;
const WINDOW_MS = 3_600_000;
const testRateLimits: RateLimitConfig = {
  keySecret: `order-photos-e2e-pepper-${randomUUID()}`,
  policies: {
    'otp-request': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'sign-in': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    refresh: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    geocode: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'document-upload': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'order-creation': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'order-transition': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'price-range': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'offer-response': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'offer-feed': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'location-report': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
  },
};

/**
 * The size cap this suite runs under — the schema's own floor
 * (`env.schema.ts` bounds `ORDER_PHOTO_MAX_BYTES` at 64 KiB), set BEFORE the
 * app boots so the real, validated `AppConfig` carries it — the same note
 * `master-verification.e2e.test.ts` makes about `ConfigModule` parsing
 * `process.env` once, at instantiation.
 */
const TEST_MAX_BYTES = 64 * 1024;

/** Small enough that the limit test attaches a handful of photos, not six. */
const TEST_MAX_PHOTOS = 2;

type ContentType = 'image/jpeg' | 'image/png' | 'image/webp';

const ORDER_PHOTO_FIELDS = [
  'createdAt',
  'id',
  'orderId',
  'sizeBytes',
  'status',
  'submittedAt',
  'updatedAt',
].sort();

const ORDER_PHOTO_UPLOAD_FIELDS = [
  'contentType',
  'expiresAt',
  'maxBytes',
  'photoId',
  'uploadUrl',
].sort();

function jpegBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}

function pngBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer;
}

function htmlBytes(size = 32): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set(new TextEncoder().encode('<html><body>hi</body></html>').slice(0, size));
  return buffer;
}

function imageBytesFor(contentType: ContentType, size = 16): Uint8Array {
  switch (contentType) {
    case 'image/jpeg':
      return jpegBytes(size);
    case 'image/png':
      return pngBytes(size);
    case 'image/webp': {
      const buffer = new Uint8Array(Math.max(size, 12));
      buffer.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
      buffer.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
      return buffer;
    }
  }
}

const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

describe('order problem photos over HTTP (issue #83)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalMaxBytes: string | undefined;
  let originalMaxPhotos: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let adminRepository: AdminRepository;
  let adminSessionService: AdminSessionService;
  let storage: StubStorageProvider;
  let serviceId: string;

  interface Customer {
    readonly userId: string;
    readonly accessToken: string;
    readonly addressId: string;
  }

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<SignedIn> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  async function signInAsCustomer(): Promise<Customer> {
    const caller = await signIn();
    const profile = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);
    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);
    const { id: addressId } = address.body as { id: string };
    return { userId: caller.userId, accessToken: caller.accessToken, addressId };
  }

  async function signInAsMaster(): Promise<SignedIn> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Sabina' });
    expect(res.status).toBe(201);
    return caller;
  }

  async function createOrder(customer: Customer): Promise<{ id: string }> {
    const res = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function masterIdFor(userId: string): Promise<string> {
    const result = await pool.query<{ id: string }>('select id from masters where user_id = $1', [
      userId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no masters row for user ${userId}`);
    }
    return row.id;
  }

  /** Assigns a master to an order directly — see the file-level comment on why. */
  async function assignMaster(orderId: string, masterId: string): Promise<void> {
    await pool.query('update orders set master_id = $2 where id = $1', [orderId, masterId]);
  }

  /**
   * Moves an order straight to an arbitrary status, bypassing
   * `order-lifecycle.ts`'s transition gate entirely — there is no cancel or
   * complete endpoint yet (EPIC 7/8), so this is the only way to test attach
   * against a non-`SEARCHING` order today.
   */
  async function setOrderStatus(orderId: string, status: string): Promise<void> {
    await pool.query('update orders set status = $2 where id = $1', [orderId, status]);
  }

  /**
   * Moves a master straight to `active` — a fresh profile starts
   * `pending_verification` (`master-verification.e2e.test.ts`), which
   * `MastersService#assertCanAcceptWork` refuses just as it would refuse a
   * suspended one. Direct SQL, bypassing the admin transition path, the same
   * construction `admin-verification.e2e.test.ts` uses: this suite is
   * assigning a master to simulate what EPIC 7's accept will eventually do,
   * not testing verification review.
   */
  async function activateMaster(masterId: string): Promise<void> {
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [masterId]);
  }

  /** Suspends a master directly — same construction as {@link activateMaster}. */
  async function suspendMaster(masterId: string): Promise<void> {
    await pool.query(
      `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
      [masterId],
    );
  }

  async function storageKeyFor(photoId: string): Promise<string> {
    const result = await pool.query<{ storage_key: string }>(
      'select storage_key from order_photos where id = $1',
      [photoId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no order_photos row for id ${photoId}`);
    }
    return row.storage_key;
  }

  async function photoRowExists(photoId: string): Promise<boolean> {
    const result = await pool.query('select 1 from order_photos where id = $1', [photoId]);
    return (result.rowCount ?? 0) > 0;
  }

  async function photoStatus(photoId: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      'select status from order_photos where id = $1',
      [photoId],
    );
    return result.rows[0]?.status;
  }

  async function photoCountFor(orderId: string): Promise<number> {
    const result = await pool.query<{ photo_count: number }>(
      'select photo_count from orders where id = $1',
      [orderId],
    );
    return result.rows[0]?.photo_count ?? 0;
  }

  async function auditCountFor(targetId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `select count(*) as count from admin_audit_log where target_type = 'order_photo' and target_id = $1`,
      [targetId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function presignPhoto(
    customer: Customer,
    contentType: ContentType = 'image/jpeg',
  ): Promise<OrderPhotoUpload> {
    const res = await post('/orders/photos/presign', customer.accessToken).send({ contentType });
    expect(res.status).toBe(201);
    return res.body as OrderPhotoUpload;
  }

  /** Presigns and confirms one photo through the stub. Returns the confirmed body. */
  async function uploadAndConfirmPhoto(
    customer: Customer,
    options: { contentType?: ContentType; sizeBytes?: number } = {},
  ): Promise<OrderPhoto> {
    const contentType = options.contentType ?? 'image/jpeg';
    const sizeBytes = options.sizeBytes ?? 16;

    const upload = await presignPhoto(customer, contentType);
    const storageKey = await storageKeyFor(upload.photoId);
    storage.putObject(storageKey, imageBytesFor(contentType, sizeBytes));

    const confirmRes = await post(`/orders/photos/${upload.photoId}/confirm`, customer.accessToken);
    expect(confirmRes.status).toBe(201);
    return confirmRes.body as OrderPhoto;
  }

  async function newAdmin(): Promise<{ accessToken: string }> {
    const created = await adminRepository.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
    });
    const session = await adminSessionService.start(created.id);
    return { accessToken: session.accessToken };
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    originalMaxBytes = process.env.ORDER_PHOTO_MAX_BYTES;
    process.env.ORDER_PHOTO_MAX_BYTES = String(TEST_MAX_BYTES);

    originalMaxPhotos = process.env.MAX_ORDER_PHOTOS;
    process.env.MAX_ORDER_PHOTOS = String(TEST_MAX_PHOTOS);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(testRateLimits)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    adminRepository = app.get(AdminRepository);
    adminSessionService = app.get(AdminSessionService);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active and pricing_kind = 'fixed' order by id limit 1`,
    );
    const seeded = rows[0]?.id;
    if (seeded === undefined) {
      throw new Error('the seed should have provided at least one active fixed-price service');
    }
    serviceId = seeded;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    restore('DATABASE_URL', originalDatabaseUrl);
    restore('ORDER_PHOTO_MAX_BYTES', originalMaxBytes);
    restore('MAX_ORDER_PHOTOS', originalMaxPhotos);
    await database.drop();
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  describe('POST /orders/photos/presign', () => {
    it('requires authentication', async () => {
      const res = await post('/orders/photos/presign').send({ contentType: 'image/jpeg' });
      expect(res.status).toBe(401);
    });

    it('answers 404 for an authenticated caller who never created a customer profile', async () => {
      const caller = await signIn();
      const res = await post('/orders/photos/presign', caller.accessToken).send({
        contentType: 'image/jpeg',
      });
      expect(res.status).toBe(404);
    });

    it('mints an upload url exposing exactly the documented wire shape, with no storage key', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders/photos/presign', customer.accessToken).send({
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(201);
      const body = res.body as OrderPhotoUpload;
      expect(Object.keys(body).sort()).toEqual(ORDER_PHOTO_UPLOAD_FIELDS);
      expect(typeof body.photoId).toBe('string');
      expect(body.contentType).toBe('image/jpeg');
      expect(body.maxBytes).toBe(TEST_MAX_BYTES);
      expect(Date.parse(body.expiresAt)).not.toBeNaN();
      const storageKey = await storageKeyFor(body.photoId);
      expect(JSON.stringify(body)).not.toContain(storageKey);
    });

    /**
     * The key is copied verbatim into every presigned URL's path by both
     * providers, and an order photo's read URLs go on the **master-facing
     * offer card** — which a broadcast hands to every eligible master in
     * range. A customer segment in the key would therefore be a stable
     * identifier, stable across every order that customer ever places,
     * printed on a card that mostly reaches masters who never take the job.
     */
    it('builds an opaque key that carries neither the customer id nor anything else derivable', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders/photos/presign', customer.accessToken).send({
        contentType: 'image/jpeg',
      });
      expect(res.status).toBe(201);
      const { photoId } = res.body as OrderPhotoUpload;

      const { rows } = await pool.query<{ customer_id: string; storage_key: string }>(
        'select customer_id, storage_key from order_photos where id = $1',
        [photoId],
      );
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.storage_key).not.toContain(row?.customer_id ?? 'the customer id');
      // One flat prefix and one uuid — nothing between them to read anything
      // out of, and nothing after it.
      expect(row?.storage_key).toMatch(
        /^orders\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    });

    it('rejects a disallowed content type — the allow-list fails closed', async () => {
      const customer = await signInAsCustomer();
      for (const contentType of ['image/gif', 'application/pdf', 'image/svg+xml']) {
        const res = await post('/orders/photos/presign', customer.accessToken).send({
          contentType,
        });
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders/photos/presign', customer.accessToken).send({
        contentType: 'image/jpeg',
        extra: 'not allowed',
      });
      expect(res.status).toBe(422);
    });

    it(
      're-presigning clears the customer’s previous unconfirmed presign — its row and its ' +
        'object — bounding outstanding presigns to one per customer',
      async () => {
        const customer = await signInAsCustomer();

        const first = await presignPhoto(customer, 'image/jpeg');
        const firstStorageKey = await storageKeyFor(first.photoId);

        const second = await presignPhoto(customer, 'image/png');

        expect(second.photoId).not.toBe(first.photoId);
        expect(await photoRowExists(first.photoId)).toBe(false);
        expect(storage.hasObject(firstStorageKey)).toBe(false);
      },
    );

    it('does not touch a confirmed photo when the customer presigns another one', async () => {
      const customer = await signInAsCustomer();
      const confirmed = await uploadAndConfirmPhoto(customer);

      await presignPhoto(customer, 'image/png');

      expect(await photoStatus(confirmed.id)).toBe('confirmed');
    });
  });

  describe('POST /orders/photos/:photoId/confirm', () => {
    it('requires authentication', async () => {
      const res = await post(`/orders/photos/${unknownUuid()}/confirm`);
      expect(res.status).toBe(401);
    });

    it('turns an uploaded image into a confirmed photo, unattached, with a real size and no server-only field leaking', async () => {
      const customer = await signInAsCustomer();
      const confirmed = await uploadAndConfirmPhoto(customer, { sizeBytes: 1024 });

      expect(Object.keys(confirmed).sort()).toEqual(ORDER_PHOTO_FIELDS);
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.orderId).toBeNull();
      expect(confirmed.sizeBytes).toBe(1024);
      expect(confirmed.submittedAt).not.toBeNull();
      expect(Date.parse(confirmed.submittedAt as string)).not.toBeNaN();
    });

    it('rejects content whose magic bytes contradict the declared type, deletes the object, but keeps the row in awaiting_upload', async () => {
      const customer = await signInAsCustomer();
      const upload = await presignPhoto(customer, 'image/png');
      const storageKey = await storageKeyFor(upload.photoId);
      // Declared PNG; the bytes that actually arrive are a JPEG.
      storage.putObject(storageKey, jpegBytes());

      const res = await post(`/orders/photos/${upload.photoId}/confirm`, customer.accessToken);

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      expect(storage.hasObject(storageKey)).toBe(false);
      expect(await photoRowExists(upload.photoId)).toBe(true);
      expect(await photoStatus(upload.photoId)).toBe('awaiting_upload');
    });

    it('rejects bytes that are not a recognised image at all', async () => {
      const customer = await signInAsCustomer();
      const upload = await presignPhoto(customer, 'image/jpeg');
      const storageKey = await storageKeyFor(upload.photoId);
      storage.putObject(storageKey, htmlBytes());

      const res = await post(`/orders/photos/${upload.photoId}/confirm`, customer.accessToken);

      expect(res.status).toBe(422);
      expect(storage.hasObject(storageKey)).toBe(false);
      expect(await photoStatus(upload.photoId)).toBe('awaiting_upload');
    });

    it('rejects an object over the configured size cap, naming both numbers, deletes the object', async () => {
      const customer = await signInAsCustomer();
      const upload = await presignPhoto(customer, 'image/jpeg');
      const storageKey = await storageKeyFor(upload.photoId);
      const oversizeBytes = TEST_MAX_BYTES + 1;
      storage.putObject(storageKey, jpegBytes(oversizeBytes));

      const res = await post(`/orders/photos/${upload.photoId}/confirm`, customer.accessToken);

      expect(res.status).toBe(422);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details?.maxBytes).toBe(TEST_MAX_BYTES);
      expect(body.error.details?.sizeBytes).toBe(oversizeBytes);
      expect(storage.hasObject(storageKey)).toBe(false);
      expect(await photoStatus(upload.photoId)).toBe('awaiting_upload');
    });

    it('answers 409 CONFLICT when confirm is called before anything was uploaded', async () => {
      const customer = await signInAsCustomer();
      const upload = await presignPhoto(customer);
      const res = await post(`/orders/photos/${upload.photoId}/confirm`, customer.accessToken);
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it('answers 409 CONFLICT on a second confirm of the same photo', async () => {
      const customer = await signInAsCustomer();
      const confirmed = await uploadAndConfirmPhoto(customer);
      const res = await post(`/orders/photos/${confirmed.id}/confirm`, customer.accessToken);
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it('answers 404 — not 403 — for confirming a stranger’s presigned photo, byte-identical to an unknown id', async () => {
      const owner = await signInAsCustomer();
      const upload = await presignPhoto(owner);
      const stranger = await signInAsCustomer();

      const confirmNotYours = await post(
        `/orders/photos/${upload.photoId}/confirm`,
        stranger.accessToken,
      );
      const confirmNeverExisted = await post(
        `/orders/photos/${unknownUuid()}/confirm`,
        stranger.accessToken,
      );

      expect(confirmNotYours.status).toBe(404);
      expect(confirmNeverExisted.status).toBe(404);
      expect(envelopeWithoutRequestId(confirmNotYours.body)).toEqual(
        envelopeWithoutRequestId(confirmNeverExisted.body),
      );
      // The owner's own presign survived the stranger's attempt.
      expect(await photoStatus(upload.photoId)).toBe('awaiting_upload');
    });
  });

  describe('POST /orders/:orderId/photos (attach)', () => {
    it('requires authentication', async () => {
      const res = await post(`/orders/${unknownUuid()}/photos`).send({ photoId: unknownUuid() });
      expect(res.status).toBe(401);
    });

    it('attaches a confirmed photo: 201, attached, visible on the order, and orders.photo_count incremented', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);

      const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      expect(res.status).toBe(201);
      const attached = res.body as OrderPhoto;
      expect(attached.status).toBe('attached');
      expect(attached.orderId).toBe(order.id);
      expect(await photoCountFor(order.id)).toBe(1);

      const list = (await get(`/orders/${order.id}/photos`, customer.accessToken))
        .body as OrderPhoto[];
      expect(list.map((photo) => photo.id)).toEqual([confirmed.id]);
    });

    it('answers 404 — not 403 — attaching to an order that is not the caller’s', async () => {
      const owner = await signInAsCustomer();
      const order = await createOrder(owner);
      const stranger = await signInAsCustomer();
      const confirmed = await uploadAndConfirmPhoto(stranger);

      const res = await post(`/orders/${order.id}/photos`, stranger.accessToken).send({
        photoId: confirmed.id,
      });

      expect(res.status).toBe(404);
    });

    it(
      'answers 404 — not 403 — attaching a photo key issued to a different customer, even to the ' +
        'caller’s own order, byte-identical to an unknown photo id',
      async () => {
        const customer = await signInAsCustomer();
        const order = await createOrder(customer);

        const stranger = await signInAsCustomer();
        const strangersPhoto = await uploadAndConfirmPhoto(stranger);

        const notYours = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: strangersPhoto.id,
        });
        const neverExisted = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: unknownUuid(),
        });

        expect(notYours.status).toBe(404);
        expect(neverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(notYours.body)).toEqual(
          envelopeWithoutRequestId(neverExisted.body),
        );
        // The stranger's photo was never attached to anybody's order.
        expect(await photoStatus(strangersPhoto.id)).toBe('confirmed');
      },
    );

    it('answers 409 attaching a photo that has not finished uploading yet', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const upload = await presignPhoto(customer);

      const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: upload.photoId,
      });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it('rejects attaching to an order no longer accepting photos, naming its status', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      await setOrderStatus(order.id, 'CANCELLED');

      const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details?.status).toBe('CANCELLED');
      // Nothing was claimed — the order's photo_count did not move.
      expect(await photoCountFor(order.id)).toBe(0);
      expect(await photoStatus(confirmed.id)).toBe('confirmed');
    });

    it.each(['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'])(
      'still accepts photos while the order is %s',
      async (status) => {
        const customer = await signInAsCustomer();
        const order = await createOrder(customer);
        await setOrderStatus(order.id, status);
        const confirmed = await uploadAndConfirmPhoto(customer);

        const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: confirmed.id,
        });

        expect(res.status).toBe(201);
      },
    );

    it('rejects a second attach of the same photo — to the same order and to a different one', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const otherOrder = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);

      const first = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });
      expect(first.status).toBe(201);

      const sameOrderAgain = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });
      const differentOrder = await post(
        `/orders/${otherOrder.id}/photos`,
        customer.accessToken,
      ).send({
        photoId: confirmed.id,
      });

      expect(sameOrderAgain.status).toBe(409);
      expect(differentOrder.status).toBe(409);
      expect(await photoCountFor(order.id)).toBe(1);
      expect(await photoCountFor(otherOrder.id)).toBe(0);
    });

    /**
     * The sequential limit test above would also pass against a read-then-write
     * implementation: nothing runs between its read and its write. This one
     * would not. Both attaches are in flight before either commits, which is
     * the shape two taps on a slow connection actually produce, and only the
     * guarded `UPDATE ... WHERE photo_count < :max` can decide it.
     *
     * The count is asserted afterwards because the failure this guards against
     * is not "both requests returned 201" — it is a count that drifts above the
     * cap and quietly narrows every later attach on that order.
     */
    it('lets exactly one of two simultaneous attaches take the last slot', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);

      for (let index = 0; index < TEST_MAX_PHOTOS - 1; index += 1) {
        const filler = await uploadAndConfirmPhoto(customer);
        const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: filler.id,
        });
        expect(res.status).toBe(201);
      }

      const first = await uploadAndConfirmPhoto(customer);
      const second = await uploadAndConfirmPhoto(customer);

      const [a, b] = await Promise.all([
        post(`/orders/${order.id}/photos`, customer.accessToken).send({ photoId: first.id }),
        post(`/orders/${order.id}/photos`, customer.accessToken).send({ photoId: second.id }),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409]);
      expect(await photoCountFor(order.id)).toBe(TEST_MAX_PHOTOS);
    });

    it('enforces the per-order photo limit with a specific error code once MAX_ORDER_PHOTOS is reached', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);

      for (let index = 0; index < TEST_MAX_PHOTOS; index += 1) {
        const confirmed = await uploadAndConfirmPhoto(customer);
        const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: confirmed.id,
        });
        expect(res.status).toBe(201);
      }

      const oneTooMany = await uploadAndConfirmPhoto(customer);
      const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: oneTooMany.id,
      });

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('ORDER_PHOTO_LIMIT_EXCEEDED');
      expect(body.error.details?.maxPhotos).toBe(TEST_MAX_PHOTOS);
      expect(await photoCountFor(order.id)).toBe(TEST_MAX_PHOTOS);
      // The rejected photo was never attached — the limit claim rolled back
      // cleanly rather than leaving it half-attached.
      expect(await photoStatus(oneTooMany.id)).toBe('confirmed');
    });
  });

  describe('GET /orders/:orderId/photos and .../download', () => {
    it('requires authentication', async () => {
      const listRes = await get(`/orders/${unknownUuid()}/photos`);
      const downloadRes = await get(`/orders/${unknownUuid()}/photos/${unknownUuid()}/download`);
      expect(listRes.status).toBe(401);
      expect(downloadRes.status).toBe(401);
    });

    it('is visible to the owning customer: list and a short-lived download url', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      const list = (await get(`/orders/${order.id}/photos`, customer.accessToken))
        .body as OrderPhoto[];
      expect(list.map((photo) => photo.id)).toEqual([confirmed.id]);

      const download = await get(
        `/orders/${order.id}/photos/${confirmed.id}/download`,
        customer.accessToken,
      );
      expect(download.status).toBe(200);
      const body = download.body as OrderPhotoDownload;
      expect(typeof body.url).toBe('string');
      expect(body.url.length).toBeGreaterThan(0);
      expect(Date.parse(body.expiresAt)).not.toBeNaN();
    });

    it(
      'answers 404 — not 403 — for another customer, on both list and download, byte-identical ' +
        'to a genuinely unknown order',
      async () => {
        // These are exactly the two routes that hand back a capability URL
        // on success, which is where an envelope that merely matched by
        // status code — but differed by a byte — would be the oracle: a
        // stranger could tell "exists, not mine" from "never existed" by
        // the shape of the 404 alone, even without ever seeing a 403.
        const owner = await signInAsCustomer();
        const order = await createOrder(owner);
        const confirmed = await uploadAndConfirmPhoto(owner);
        await post(`/orders/${order.id}/photos`, owner.accessToken).send({
          photoId: confirmed.id,
        });

        const stranger = await signInAsCustomer();

        const listNotYours = await get(`/orders/${order.id}/photos`, stranger.accessToken);
        const listNeverExisted = await get(`/orders/${unknownUuid()}/photos`, stranger.accessToken);
        expect(listNotYours.status).toBe(404);
        expect(listNeverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(listNotYours.body)).toEqual(
          envelopeWithoutRequestId(listNeverExisted.body),
        );

        const downloadNotYours = await get(
          `/orders/${order.id}/photos/${confirmed.id}/download`,
          stranger.accessToken,
        );
        const downloadNeverExisted = await get(
          `/orders/${unknownUuid()}/photos/${unknownUuid()}/download`,
          stranger.accessToken,
        );
        expect(downloadNotYours.status).toBe(404);
        expect(downloadNeverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(downloadNotYours.body)).toEqual(
          envelopeWithoutRequestId(downloadNeverExisted.body),
        );
      },
    );

    it(
      'is visible to the order’s assigned master, and not to an unassigned one — the path issue ' +
        '#83 asks to note cannot be fully exercised until EPIC 7 ships accept, tested here against ' +
        'orders.master_id set directly',
      async () => {
        const customer = await signInAsCustomer();
        const order = await createOrder(customer);
        const confirmed = await uploadAndConfirmPhoto(customer);
        await post(`/orders/${order.id}/photos`, customer.accessToken).send({
          photoId: confirmed.id,
        });

        const assigned = await signInAsMaster();
        const assignedMasterId = await masterIdFor(assigned.userId);
        await activateMaster(assignedMasterId);
        await assignMaster(order.id, assignedMasterId);

        const unassigned = await signInAsMaster();

        const assignedList = await get(`/orders/${order.id}/photos`, assigned.accessToken);
        const assignedDownload = await get(
          `/orders/${order.id}/photos/${confirmed.id}/download`,
          assigned.accessToken,
        );
        const unassignedList = await get(`/orders/${order.id}/photos`, unassigned.accessToken);
        // The download route is the one that hands back a capability URL —
        // asserting only the list route here would let the download
        // authorization check be deleted with every test still green.
        const unassignedDownload = await get(
          `/orders/${order.id}/photos/${confirmed.id}/download`,
          unassigned.accessToken,
        );

        expect(assignedList.status).toBe(200);
        expect((assignedList.body as OrderPhoto[]).map((photo) => photo.id)).toEqual([
          confirmed.id,
        ]);
        expect(assignedDownload.status).toBe(200);
        expect(unassignedList.status).toBe(404);
        expect(unassignedDownload.status).toBe(404);
      },
    );

    it('answers 404 for a master assigned to the order but subsequently suspended — a role claim is a cache, not an authority', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      const assigned = await signInAsMaster();
      const assignedMasterId = await masterIdFor(assigned.userId);
      await activateMaster(assignedMasterId);
      await assignMaster(order.id, assignedMasterId);
      await suspendMaster(assignedMasterId);

      const listRes = await get(`/orders/${order.id}/photos`, assigned.accessToken);
      const downloadRes = await get(
        `/orders/${order.id}/photos/${confirmed.id}/download`,
        assigned.accessToken,
      );

      expect(listRes.status).toBe(404);
      expect(downloadRes.status).toBe(404);
    });

    it('answers 404 for a photo that exists but is not attached to the named order', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      // Deliberately never attached.

      const res = await get(
        `/orders/${order.id}/photos/${confirmed.id}/download`,
        customer.accessToken,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/orders/:orderId/photos/:photoId/download', () => {
    it('rejects a consumer access token', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      const res = await get(
        `/admin/orders/${order.id}/photos/${confirmed.id}/download`,
        customer.accessToken,
      );
      expect(res.status).toBe(401);
    });

    it('returns a short-lived read url for an admin, and writes exactly one audit row', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
      });

      const admin = await newAdmin();
      const before = await auditCountFor(confirmed.id);

      const res = await get(
        `/admin/orders/${order.id}/photos/${confirmed.id}/download`,
        admin.accessToken,
      );

      expect(res.status).toBe(200);
      const body = res.body as OrderPhotoDownload;
      expect(typeof body.url).toBe('string');
      expect(Date.parse(body.expiresAt)).not.toBeNaN();
      expect(await auditCountFor(confirmed.id)).toBe(before + 1);
    });

    it('answers 404 for a photo not attached to the named order, and still writes an audit row', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);
      // Never attached.
      const admin = await newAdmin();
      const before = await auditCountFor(confirmed.id);

      const res = await get(
        `/admin/orders/${order.id}/photos/${confirmed.id}/download`,
        admin.accessToken,
      );

      expect(res.status).toBe(404);
      // An admin probing guessed ids leaves a trace even on a miss — the
      // audit trail is a record of what was looked at, attempts included.
      expect(await auditCountFor(confirmed.id)).toBe(before + 1);
    });

    it('answers 404 for a photo id that never existed at all, and still writes an audit row against it', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const admin = await newAdmin();
      const guessedPhotoId = unknownUuid();

      const res = await get(
        `/admin/orders/${order.id}/photos/${guessedPhotoId}/download`,
        admin.accessToken,
      );

      expect(res.status).toBe(404);
      expect(await auditCountFor(guessedPhotoId)).toBe(1);
    });
  });

  describe('order creation', () => {
    it('still succeeds with no photos at all — an upload never blocks it', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders', customer.accessToken).send({
        serviceId,
        addressId: customer.addressId,
        description: DESCRIPTION,
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(201);
      expect(await photoCountFor((res.body as { id: string }).id)).toBe(0);
    });
  });

  /**
   * The acceptance criterion "the API never receives image bytes"
   * (ADR-0005) is true structurally — no route binds a request body capable
   * of carrying one — and structural guarantees are exactly the ones a later
   * convenience endpoint is most likely to quietly break. Asserted two ways:
   * the JSON schemas have no field for one, and the one route that names a
   * single photo with no body of its own (`confirm`) truly reads nothing
   * from whatever body a client sends it.
   */
  describe('issue #83 acceptance criterion: the API never receives image bytes', () => {
    it('rejects an attempt to smuggle image bytes into the presign body as an unknown field', async () => {
      const customer = await signInAsCustomer();
      const res = await post('/orders/photos/presign', customer.accessToken).send({
        contentType: 'image/jpeg',
        photo: 'a'.repeat(1024),
      });
      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an attempt to smuggle image bytes into the attach body as an unknown field', async () => {
      const customer = await signInAsCustomer();
      const order = await createOrder(customer);
      const confirmed = await uploadAndConfirmPhoto(customer);

      const res = await post(`/orders/${order.id}/photos`, customer.accessToken).send({
        photoId: confirmed.id,
        bytes: 'a'.repeat(1024),
      });

      expect(res.status).toBe(422);
    });

    it(
      'confirm has no @Body() of its own — a large JSON payload sent alongside it is simply never ' +
        'read, and the outcome is identical to sending none',
      async () => {
        const customer = await signInAsCustomer();
        const upload = await presignPhoto(customer);
        const storageKey = await storageKeyFor(upload.photoId);
        storage.putObject(storageKey, jpegBytes());

        const res = await post(
          `/orders/photos/${upload.photoId}/confirm`,
          customer.accessToken,
        ).send({ notAnything: 'x'.repeat(4096) });

        expect(res.status).toBe(201);
        expect((res.body as OrderPhoto).status).toBe('confirmed');
      },
    );
  });
});
