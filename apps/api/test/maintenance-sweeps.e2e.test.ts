import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  MasterDocument,
  MasterDocumentUpload,
  OrderPhoto,
  OrderPhotoUpload,
} from '@tezusta/types';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { GeocodeCacheRepository } from '../src/infra/geo/geocode-cache.repository';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { MAINTENANCE_QUEUE } from '../src/infra/queue/queue.constants';
import { RecurringWorkService } from '../src/infra/queue/recurring-work.service';
import { createBullmqRedisClient } from '../src/infra/redis/bullmq-connection.provider';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  AUTH_RETENTION_JOB,
  GEOCODE_CACHE_SWEEP_JOB,
  MAINTENANCE_JOBS,
  MASTER_DOCUMENT_SWEEP_JOB,
  MASTER_LOCATION_SWEEP_JOB,
  ORDER_PHOTO_SWEEP_JOB,
} from '../src/modules/maintenance/maintenance.constants';
import { DISPATCH_RECONCILE_JOB } from '../src/modules/dispatch/dispatch.constants';
import { PUSH_RECEIPT_SWEEP_JOB } from '../src/modules/notifications/push-receipts.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { expectLoggerIsListening, spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The five retention sweeps (#57, #69, #92, #128, #105) against a real
 * Postgres, a real Redis and the real `AppModule` graph.
 *
 * **The handler is invoked directly, not waited for.** A sweep's schedule is
 * a BullMQ job scheduler measured in minutes, and a test that waited one out
 * would be a test about `setTimeout`. What the suite asserts instead is the
 * two things that can actually be wrong: what each sweep deletes and what it
 * refuses to delete, and — once, through `RecurringWorkService.runNow` — that
 * a job on the `maintenance` queue really does reach its handler through the
 * worker rather than only through this file calling it.
 *
 * `MAINTENANCE_SWEEP_INTERVAL_MINUTES` is 0 here (the value `setup-env.ts`
 * gives every suite), so nothing sweeps in the background while a test is
 * asserting on rows either side of a cutoff. The scheduling behaviour has its
 * own block at the bottom, which boots its own apps to look at it.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

/** A tiny, valid JPEG, which is all the confirm path's magic-byte sniff wants. */
function jpegBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(Math.max(size, 3));
  buffer.set([0xff, 0xd8, 0xff]);
  return buffer;
}

/** The batch ceiling this suite runs with — small, so a batch can be filled. */
const BATCH_SIZE = 3;

/** Comfortably past the shipped 30-day `JWT_REFRESH_TTL`; the schema floor. */
const RETENTION_DAYS = 31;

const ABANDONED_AFTER_HOURS = 24;

/**
 * The abandoned-verification-document window (#128). Longer than the photo
 * one here as it is in production, so a test that confused the two would fail
 * rather than pass by coincidence.
 */
const DOCUMENT_ABANDONED_AFTER_HOURS = 168;

/**
 * The position-trail retention window (#105). Pinned rather than left at the
 * shipped 60 minutes so the two sides of the cutoff are written down here,
 * where the assertions can be read against them.
 */
const TRAIL_MINUTES = 30;

/**
 * The longer window a `reuse_detected` family is held to. Production ships a
 * year (ADR-0027); this suite overrides it because what is under test is the
 * mechanism — that the cutoff is applied, and applied separately from the
 * ordinary one — and ageing rows by 370 days would only make it slower. The
 * shipped number is asserted where it is decided, in `parse-env.test.ts`.
 */
const INCIDENT_RETENTION_DAYS = 90;

describe('the maintenance retention sweeps', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let config: AppConfig;
  let handlers: DeferredJobHandlerRegistry;
  let recurring: RecurringWorkService;
  let sessionsRepo: SessionsRepository;
  let sessionsService: SessionsService;
  let usersRepo: UsersRepository;
  let geocodeCache: GeocodeCacheRepository;
  let storage: StubStorageProvider;
  let serviceId: string;

  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('MAINTENANCE_BATCH_SIZE', String(BATCH_SIZE));
    set('AUTH_RETENTION_DAYS', String(RETENTION_DAYS));
    set('AUTH_INCIDENT_RETENTION_DAYS', String(INCIDENT_RETENTION_DAYS));
    set('ORDER_PHOTO_ABANDONED_AFTER_HOURS', String(ABANDONED_AFTER_HOURS));
    set('MASTER_DOCUMENT_ABANDONED_AFTER_HOURS', String(DOCUMENT_ABANDONED_AFTER_HOURS));
    set('MASTER_LOCATION_TRAIL_MINUTES', String(TRAIL_MINUTES));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The application's real logger, not Nest's `TestingLogger` — whose
      // `log`, `warn`, `debug` and `verbose` are empty bodies. The location
      // sweep's "no coordinate is ever logged" test below writes at `log`, so
      // against `TestingLogger` it would assert nothing and pass (#127).
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    config = app.get<AppConfig>(APP_CONFIG);
    handlers = app.get(DeferredJobHandlerRegistry);
    recurring = app.get(RecurringWorkService);
    sessionsRepo = app.get(SessionsRepository);
    sessionsService = app.get(SessionsService);
    usersRepo = app.get(UsersRepository);
    geocodeCache = app.get(GeocodeCacheRepository);
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
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  /** Runs one sweep the way the worker would: through its registered handler. */
  async function runSweep(job: string): Promise<void> {
    await handlers.resolve(job)({});
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  // ---------------------------------------------------------------- #57 ----

  interface SeededSession {
    readonly sessionId: string;
    readonly refreshTokenId: string;
  }

  /** A real session and refresh token, through the service that issues them. */
  async function openSession(): Promise<SeededSession> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const { rows } = await pool.query<{ id: string; session_id: string }>(
      `select rt.id, rt.session_id
         from refresh_tokens rt
         join sessions s on s.id = rt.session_id
        where s.user_id = $1
        order by rt.created_at desc
        limit 1`,
      [created.user.id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('startSession should have written a refresh token');
    }
    expect(pair.refreshToken.startsWith(row.id)).toBe(true);
    return { sessionId: row.session_id, refreshTokenId: row.id };
  }

  /** Moves a whole family's clocks back, as if it had been issued `days` ago. */
  async function ageSession(session: SeededSession, days: number): Promise<void> {
    await pool.query(
      `update refresh_tokens set expires_at = now() - ($2 || ' days')::interval
        where session_id = $1`,
      [session.sessionId, String(days)],
    );
    await pool.query(
      `update sessions set expires_at = now() - ($2 || ' days')::interval where id = $1`,
      [session.sessionId, String(days)],
    );
  }

  /** Marks a family as the one a theft signal fired on, revoked `days` ago. */
  async function markStolen(session: SeededSession, days: number): Promise<void> {
    await pool.query(
      `update sessions
          set revoked_at = now() - ($2 || ' days')::interval,
              revoked_reason = 'reuse_detected'
        where id = $1`,
      [session.sessionId, String(days)],
    );
  }

  async function sessionExists(sessionId: string): Promise<boolean> {
    const { rowCount } = await pool.query('select 1 from sessions where id = $1', [sessionId]);
    return (rowCount ?? 0) > 0;
  }

  async function refreshTokenExists(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('select 1 from refresh_tokens where id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  describe('auth retention (#57)', () => {
    it('deletes a family that has been expired longer than the retention window', async () => {
      const stale = await openSession();
      await ageSession(stale, RETENTION_DAYS + 1);

      await runSweep(AUTH_RETENTION_JOB);

      expect(await refreshTokenExists(stale.refreshTokenId)).toBe(false);
      expect(await sessionExists(stale.sessionId)).toBe(false);
    });

    it('never deletes a live session or its usable refresh token', async () => {
      const live = await openSession();

      await runSweep(AUTH_RETENTION_JOB);

      expect(await refreshTokenExists(live.refreshTokenId)).toBe(true);
      expect(await sessionExists(live.sessionId)).toBe(true);
    });

    it('keeps a family that expired inside the window — the boundary, not just the extremes', async () => {
      const justInside = await openSession();
      // Expired, but one day short of the retention window: still evidence.
      await ageSession(justInside, RETENTION_DAYS - 1);

      await runSweep(AUTH_RETENTION_JOB);

      expect(await refreshTokenExists(justInside.refreshTokenId)).toBe(true);
      expect(await sessionExists(justInside.sessionId)).toBe(true);
    });

    it('is a no-op the second time', async () => {
      const stale = await openSession();
      await ageSession(stale, RETENTION_DAYS + 1);

      await runSweep(AUTH_RETENTION_JOB);
      const before = await pool.query<{ count: string }>(
        'select count(*)::text as count from refresh_tokens',
      );
      await runSweep(AUTH_RETENTION_JOB);
      const after = await pool.query<{ count: string }>(
        'select count(*)::text as count from refresh_tokens',
      );

      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });

    it('holds a family revoked for reuse_detected to the longer window — it is the theft record', async () => {
      const stolen = await openSession();
      // Well past the ordinary window, well inside the incident one.
      await ageSession(stolen, RETENTION_DAYS + 5);
      await markStolen(stolen, RETENTION_DAYS + 5);

      await runSweep(AUTH_RETENTION_JOB);

      expect(await refreshTokenExists(stolen.refreshTokenId)).toBe(true);
      expect(await sessionExists(stolen.sessionId)).toBe(true);
    });

    it('retires a reuse_detected family once even that window has passed — longer, not forever', async () => {
      const ancient = await openSession();
      await ageSession(ancient, INCIDENT_RETENTION_DAYS + 5);
      await markStolen(ancient, INCIDENT_RETENTION_DAYS + 5);

      await runSweep(AUTH_RETENTION_JOB);

      expect(await refreshTokenExists(ancient.refreshTokenId)).toBe(false);
      expect(await sessionExists(ancient.sessionId)).toBe(false);
    });

    it('deletes in bounded batches, so one statement can never be the whole table', async () => {
      const families: SeededSession[] = [];
      for (let i = 0; i < BATCH_SIZE + 2; i += 1) {
        const session = await openSession();
        await ageSession(session, RETENTION_DAYS + 5);
        families.push(session);
      }

      const now = Date.now();
      const cutoff = new Date(now - RETENTION_DAYS * 86_400_000);
      const incidentCutoff = new Date(now - INCIDENT_RETENTION_DAYS * 86_400_000);
      // The bound is the statement's, not the loop's: asking for two gets two
      // even though five are eligible. This is what keeps one iteration from
      // holding a long transaction on the auth schema's largest table.
      expect(
        await sessionsRepo.deleteExpiredRefreshTokens({ cutoff, incidentCutoff, limit: 2 }),
      ).toBe(2);

      // And the sweep itself still finishes the job across its own batches.
      await runSweep(AUTH_RETENTION_JOB);
      for (const family of families) {
        expect(await refreshTokenExists(family.refreshTokenId)).toBe(false);
        expect(await sessionExists(family.sessionId)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------- #69 ----

  let addressCounter = 0;
  function uniqueAddress(): string {
    addressCounter += 1;
    return `sweep test address ${String(addressCounter)}`;
  }

  /** Writes one cache row. A negative TTL puts `expires_at` in the past. */
  async function cacheRow(ttlDays: number): Promise<string> {
    const key = uniqueAddress();
    await geocodeCache.put(key, { latitude: 40.4, longitude: 49.8, placeId: null }, ttlDays);
    return key;
  }

  async function cacheRowExists(key: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      'select 1 from geocode_cache where normalised_address = $1',
      [key],
    );
    return (rowCount ?? 0) > 0;
  }

  describe('the geocode cache sweep (#69)', () => {
    it('deletes expired rows and leaves unexpired ones', async () => {
      const expired = await cacheRow(-1);
      const live = await cacheRow(30);

      await runSweep(GEOCODE_CACHE_SWEEP_JOB);

      expect(await cacheRowExists(expired)).toBe(false);
      expect(await cacheRowExists(live)).toBe(true);
    });

    it('respects the batch limit', async () => {
      await cacheRow(-1);
      await cacheRow(-1);
      await cacheRow(-1);

      expect(await geocodeCache.deleteExpired(1)).toBe(1);
      expect(await geocodeCache.deleteExpired(10)).toBe(2);
    });

    it('is cheap and quiet when there is nothing to delete', async () => {
      await runSweep(GEOCODE_CACHE_SWEEP_JOB);
      await expect(runSweep(GEOCODE_CACHE_SWEEP_JOB)).resolves.toBeUndefined();
      expect(await geocodeCache.deleteExpired(BATCH_SIZE)).toBe(0);
    });

    it('runs through the worker when a job is put on the maintenance queue', async () => {
      const expired = await cacheRow(-1);

      // The one assertion in this file that goes through BullMQ end to end:
      // producer, queue, worker, registry, handler. Everything else calls the
      // handler directly, which would pass just as happily if the processor
      // were never wired to the maintenance queue at all.
      await recurring.runNow(GEOCODE_CACHE_SWEEP_JOB);

      const deadline = Date.now() + 15_000;
      while (await cacheRowExists(expired)) {
        if (Date.now() > deadline) {
          throw new Error('the queued maintenance job never reached its handler');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await cacheRowExists(expired)).toBe(false);
    });
  });

  // ---------------------------------------------------------------- #92 ----

  interface Customer {
    readonly accessToken: string;
    readonly addressId: string;
  }

  async function signInAsCustomer(): Promise<Customer> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const profile = await post('/customers', pair.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);
    const address = await post('/addresses', pair.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);
    return { accessToken: pair.accessToken, addressId: (address.body as { id: string }).id };
  }

  async function storageKeyFor(photoId: string): Promise<string> {
    const { rows } = await pool.query<{ storage_key: string }>(
      'select storage_key from order_photos where id = $1',
      [photoId],
    );
    const key = rows[0]?.storage_key;
    if (key === undefined) {
      throw new Error(`no order_photos row for ${photoId}`);
    }
    return key;
  }

  async function confirmPhoto(customer: Customer): Promise<{ photoId: string; key: string }> {
    const presigned = await post('/orders/photos/presign', customer.accessToken).send({
      contentType: 'image/jpeg',
    });
    expect(presigned.status).toBe(201);
    const { photoId } = presigned.body as OrderPhotoUpload;

    const key = await storageKeyFor(photoId);
    storage.putObject(key, jpegBytes());

    const confirmed = await post(`/orders/photos/${photoId}/confirm`, customer.accessToken);
    expect(confirmed.status).toBe(201);
    expect((confirmed.body as OrderPhoto).status).toBe('confirmed');
    return { photoId, key };
  }

  async function agePhoto(photoId: string, hours: number): Promise<void> {
    await pool.query(
      `update order_photos set submitted_at = now() - ($2 || ' hours')::interval where id = $1`,
      [photoId, String(hours)],
    );
  }

  async function photoExists(photoId: string): Promise<boolean> {
    const { rowCount } = await pool.query('select 1 from order_photos where id = $1', [photoId]);
    return (rowCount ?? 0) > 0;
  }

  describe('the abandoned order photo sweep (#92)', () => {
    it('deletes an abandoned photo and its object once the window has passed', async () => {
      const customer = await signInAsCustomer();
      const { photoId, key } = await confirmPhoto(customer);
      await agePhoto(photoId, ABANDONED_AFTER_HOURS + 1);

      await runSweep(ORDER_PHOTO_SWEEP_JOB);

      expect(await photoExists(photoId)).toBe(false);
      expect(storage.hasObject(key)).toBe(false);
    });

    it('never touches an attached photo, at any age', async () => {
      const customer = await signInAsCustomer();
      const { photoId, key } = await confirmPhoto(customer);

      const order = await post('/orders', customer.accessToken).send({
        serviceId,
        addressId: customer.addressId,
        description: 'Kran sızır, təcili baxmaq lazımdır.',
        idempotencyKey: randomUUID(),
      });
      expect(order.status).toBe(201);
      const attached = await post(
        `/orders/${(order.body as { id: string }).id}/photos`,
        customer.accessToken,
      ).send({ photoId });
      expect(attached.status).toBe(201);

      // Older than any plausible window, and still not the sweep's business.
      await agePhoto(photoId, ABANDONED_AFTER_HOURS * 100);

      await runSweep(ORDER_PHOTO_SWEEP_JOB);

      expect(await photoExists(photoId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);
    });

    it('leaves a recently confirmed photo alone', async () => {
      const customer = await signInAsCustomer();
      const { photoId, key } = await confirmPhoto(customer);

      await runSweep(ORDER_PHOTO_SWEEP_JOB);

      expect(await photoExists(photoId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);
    });

    it('keeps the row when the object cannot be deleted, so the bytes are never orphaned', async () => {
      const customer = await signInAsCustomer();
      const { photoId, key } = await confirmPhoto(customer);
      await agePhoto(photoId, ABANDONED_AFTER_HOURS + 1);

      const failing = vi
        .spyOn(storage, 'delete')
        .mockRejectedValueOnce(new Error('object storage is unreachable'));

      // The sweep re-throws, which is how a job asks BullMQ for a retry.
      await expect(runSweep(ORDER_PHOTO_SWEEP_JOB)).rejects.toThrow(/unreachable/);
      failing.mockRestore();

      // The row survived the rolled-back transaction, and so did the object.
      expect(await photoExists(photoId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);

      // ...and the next run finishes the job.
      await runSweep(ORDER_PHOTO_SWEEP_JOB);
      expect(await photoExists(photoId)).toBe(false);
      expect(storage.hasObject(key)).toBe(false);
    });
  });

  // --------------------------------------------------------------- #128 ----

  interface Master {
    readonly accessToken: string;
    readonly masterId: string;
  }

  async function signInAsMaster(): Promise<Master> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const profile = await post('/masters', pair.accessToken).send({ displayName: 'Usta Elçin' });
    expect(profile.status).toBe(201);
    return { accessToken: pair.accessToken, masterId: (profile.body as { id: string }).id };
  }

  async function documentStorageKey(documentId: string): Promise<string> {
    const { rows } = await pool.query<{ storage_key: string }>(
      'select storage_key from master_documents where id = $1',
      [documentId],
    );
    const key = rows[0]?.storage_key;
    if (key === undefined) {
      throw new Error(`no master_documents row for ${documentId}`);
    }
    return key;
  }

  /**
   * A presigned document whose bytes are in storage and whose confirm never
   * arrived — the state this sweep is about, and exactly what a master who
   * closed the app mid-upload leaves behind. Storage has no idea we never
   * accepted them, which is why the bytes are the problem and not the row.
   */
  async function presignDocument(
    master: Master,
    documentType = 'id_card_front',
  ): Promise<{ documentId: string; key: string }> {
    const presigned = await post('/masters/me/documents/presign', master.accessToken).send({
      documentType,
      contentType: 'image/jpeg',
    });
    expect(presigned.status).toBe(201);
    const { documentId } = presigned.body as MasterDocumentUpload;

    const key = await documentStorageKey(documentId);
    storage.putObject(key, jpegBytes());
    return { documentId, key };
  }

  /**
   * Time-travels a master's document activity.
   *
   * Every row of that master moves, because the window is measured from the
   * master's LAST activity rather than from one row's age — ageing a single
   * row would leave a sibling fresh and, correctly, protect the lot.
   */
  async function ageDocumentsOf(masterId: string, hours: number): Promise<void> {
    await pool.query(
      `update master_documents
          set updated_at = now() - ($2 || ' hours')::interval,
              created_at = now() - ($2 || ' hours')::interval
        where master_id = $1`,
      [masterId, String(hours)],
    );
  }

  async function documentExists(documentId: string): Promise<boolean> {
    const { rowCount } = await pool.query('select 1 from master_documents where id = $1', [
      documentId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  describe('the abandoned verification document sweep (#128)', () => {
    it('deletes an unconfirmed document and its object once the window has passed', async () => {
      const master = await signInAsMaster();
      const { documentId, key } = await presignDocument(master);
      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS + 1);

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);

      expect(await documentExists(documentId)).toBe(false);
      expect(storage.hasObject(key)).toBe(false);
    });

    it('never touches a document that reached review, at any age', async () => {
      // `pending_review` is "waiting for an admin", which is the one state an
      // abandoned application is not in. Evidence behind a pending decision is
      // not the sweep's business however old it gets
      // (`docs/product/admin-flow.md`, no destructive deletes).
      const master = await signInAsMaster();
      const { documentId, key } = await presignDocument(master);

      const confirmed = await post(
        `/masters/me/documents/${documentId}/confirm`,
        master.accessToken,
      );
      expect(confirmed.status).toBe(201);
      expect((confirmed.body as MasterDocument).status).toBe('pending_review');

      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS * 100);

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);

      expect(await documentExists(documentId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);
    });

    it('leaves a document still inside the window alone', async () => {
      const master = await signInAsMaster();
      const { documentId, key } = await presignDocument(master);

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);

      expect(await documentExists(documentId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);
    });

    it('keeps an old presign belonging to a master who is still gathering documents', async () => {
      // The failure the window's definition exists to avoid. Measuring each
      // row separately would delete the first of three documents out from
      // under somebody still finding the third — and that person is precisely
      // the one a generous window was for.
      const master = await signInAsMaster();
      const stale = await presignDocument(master, 'id_card_front');
      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS + 1);

      // ...and now they come back and start the next document.
      const fresh = await presignDocument(master, 'id_card_back');

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);

      expect(await documentExists(stale.documentId)).toBe(true);
      expect(storage.hasObject(stale.key)).toBe(true);
      expect(await documentExists(fresh.documentId)).toBe(true);
    });

    it('spares a document confirmed after it was already old enough to sweep', async () => {
      // The race the conditional DELETE exists for, made deterministic: the
      // row leaves `awaiting_upload` after it qualified. The guard is in the
      // WHERE clause rather than in a read before it, so the sweep finds no
      // row instead of deleting a document somebody just submitted.
      const master = await signInAsMaster();
      const { documentId, key } = await presignDocument(master);
      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS + 1);

      const confirmed = await post(
        `/masters/me/documents/${documentId}/confirm`,
        master.accessToken,
      );
      expect(confirmed.status).toBe(201);

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);

      expect(await documentExists(documentId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);
    });

    it('keeps the row when the object cannot be deleted, so the bytes are never orphaned', async () => {
      const master = await signInAsMaster();
      const { documentId, key } = await presignDocument(master);
      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS + 1);

      const failing = vi
        .spyOn(storage, 'delete')
        .mockRejectedValueOnce(new Error('object storage is unreachable'));

      // The sweep re-throws, which is how a job asks BullMQ for a retry.
      await expect(runSweep(MASTER_DOCUMENT_SWEEP_JOB)).rejects.toThrow(/unreachable/);
      failing.mockRestore();

      // The row survived the rolled-back transaction, and so did the object.
      expect(await documentExists(documentId)).toBe(true);
      expect(storage.hasObject(key)).toBe(true);

      // ...and the next run finishes the job.
      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);
      expect(await documentExists(documentId)).toBe(false);
      expect(storage.hasObject(key)).toBe(false);
    });

    it('is idempotent — a second run deletes nothing', async () => {
      const master = await signInAsMaster();
      const { documentId } = await presignDocument(master);
      await ageDocumentsOf(master.masterId, DOCUMENT_ABANDONED_AFTER_HOURS + 1);

      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);
      expect(await documentExists(documentId)).toBe(false);

      const deletes = vi.spyOn(storage, 'delete');
      await runSweep(MASTER_DOCUMENT_SWEEP_JOB);
      expect(deletes).not.toHaveBeenCalled();
      deletes.mockRestore();
    });
  });

  // --------------------------------------------------------------- #105 ----

  /** A position for `minutesAgo`, planted straight into the table. */
  async function plantPosition(
    masterId: string,
    minutesAgo: number,
    position = { latitude: 40.372613, longitude: 49.842717 },
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into master_locations (id, master_id, position, recorded_at)
       values (gen_random_uuid(), $1,
               ST_SetSRID(ST_MakePoint($2, $3), 4326),
               now() - ($4 || ' minutes')::interval)
       returning id`,
      [masterId, String(position.longitude), String(position.latitude), String(minutesAgo)],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('planting a position should have returned its id');
    }
    return id;
  }

  async function positionExists(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('select 1 from master_locations where id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async function positionCount(masterId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from master_locations where master_id = $1',
      [masterId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  describe('the master location trail sweep (#105)', () => {
    it('ages out the trail of a master who stopped reporting and never came back', async () => {
      // The whole population this sweep exists for: nothing will ever run on
      // this master's behalf again, so the write-path prune cannot reach them.
      const gone = await signInAsMaster();
      const stale = await plantPosition(gone.masterId, TRAIL_MINUTES + 1);
      const older = await plantPosition(gone.masterId, TRAIL_MINUTES * 4);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);

      expect(await positionExists(stale)).toBe(false);
      expect(await positionExists(older)).toBe(false);
    });

    it('leaves a row still inside the retention window alone', async () => {
      const master = await signInAsMaster();
      const fresh = await plantPosition(master.masterId, TRAIL_MINUTES - 1);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);

      expect(await positionExists(fresh)).toBe(true);
    });

    it('never deletes the current position of a master who is still reporting', async () => {
      // The acceptance criterion the issue asks to be decided explicitly, and
      // the decision is that no `LIMIT` enforces it: a master reporting inside
      // the window has their newest row inside the window, so the cutoff
      // cannot reach it. The stale half of the same trail still goes.
      const working = await signInAsMaster();
      const current = await plantPosition(working.masterId, 0);
      const trail = await plantPosition(working.masterId, TRAIL_MINUTES + 5);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);

      expect(await positionExists(current)).toBe(true);
      expect(await positionExists(trail)).toBe(false);
    });

    it('deletes more rows than fit in one batch', async () => {
      // `MAINTENANCE_BATCH_SIZE` is 3 in this suite, so seven rows is three
      // batches and a short one — the loop has to come back for them rather
      // than stopping when the first batch is full.
      const gone = await signInAsMaster();
      const planted: string[] = [];
      for (let index = 0; index < BATCH_SIZE * 2 + 1; index += 1) {
        planted.push(await plantPosition(gone.masterId, TRAIL_MINUTES + 1 + index));
      }

      await runSweep(MASTER_LOCATION_SWEEP_JOB);

      for (const id of planted) {
        expect(await positionExists(id)).toBe(false);
      }
      expect(await positionCount(gone.masterId)).toBe(0);
    });

    it('is a no-op the second time', async () => {
      const gone = await signInAsMaster();
      await plantPosition(gone.masterId, TRAIL_MINUTES + 1);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);
      expect(await positionCount(gone.masterId)).toBe(0);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);
      expect(await positionCount(gone.masterId)).toBe(0);
    });

    it('leaves the append-only trigger refusing an ordinary DELETE afterwards', async () => {
      // The `SET LOCAL` the sweep publishes must not survive its transaction:
      // the pool hands the same connection to the next caller, and a retention
      // permission that leaked would make `master_locations` silently editable
      // from anywhere.
      const master = await signInAsMaster();
      const fresh = await plantPosition(master.masterId, 1);
      await plantPosition(master.masterId, TRAIL_MINUTES + 1);

      await runSweep(MASTER_LOCATION_SWEEP_JOB);

      await expect(
        pool.query('delete from master_locations where id = $1', [fresh]),
      ).rejects.toThrow(/append-only/);
      expect(await positionExists(fresh)).toBe(true);
    });

    it('logs a count and never a coordinate', async () => {
      const gone = await signInAsMaster();
      await plantPosition(gone.masterId, TRAIL_MINUTES + 1, {
        latitude: 40.372613,
        longitude: 49.842717,
      });

      const sink: string[] = [];
      const spies: MockInstance[] = spyOnEveryLogSink(sink);
      try {
        expectLoggerIsListening(sink, 'maintenance-sweeps.e2e');

        await runSweep(MASTER_LOCATION_SWEEP_JOB);

        const logged = sink.join('\n');
        // The production line itself is the second positive control: it
        // proves the sink caught what the negative assertions are about.
        expect(logged).toContain('Master locations: deleted');
        for (const fragment of ['40.372613', '49.842717', gone.masterId]) {
          expect(logged).not.toContain(fragment);
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  });

  // ------------------------------------------------------- the schedule ----

  describe('scheduling', () => {
    async function schedulerIds(): Promise<string[]> {
      const connection = createBullmqRedisClient(config.redis.url);
      const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: config.queue.prefix });
      try {
        const schedulers = await queue.getJobSchedulers();
        return schedulers.map((scheduler) => scheduler.key).sort();
      } finally {
        await queue.close();
        connection.disconnect();
      }
    }

    async function bootWith(
      overrides: Readonly<Record<string, string>>,
    ): Promise<NestFastifyApplication> {
      const previous = new Map<string, string | undefined>();
      for (const [name, value] of Object.entries(overrides)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      try {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const booted = moduleRef.createNestApplication<NestFastifyApplication>(
          new FastifyAdapter(),
        );
        await booted.init();
        return booted;
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    }

    async function bootWithInterval(minutes: string): Promise<NestFastifyApplication> {
      return bootWith({ MAINTENANCE_SWEEP_INTERVAL_MINUTES: minutes });
    }

    it('registers one scheduler per sweep, and removes them all when the interval is zero', async () => {
      // A whole day, so no iteration can fire while this test runs — what is
      // under test is that the scheduler exists, not that it ticks.
      const scheduled = await bootWithInterval('1440');
      try {
        expect(await schedulerIds()).toEqual([...MAINTENANCE_JOBS].sort());
      } finally {
        await scheduled.close();
      }

      // Zero is not "do not register": it is "make sure there is nothing
      // registered", or a scheduler left by an earlier release keeps
      // producing jobs after the flag is turned off.
      const disabled = await bootWithInterval('0');
      try {
        expect(await schedulerIds()).toEqual([]);
      } finally {
        await disabled.close();
      }
    }, 60_000);

    /**
     * The orphaned-search reconciler (#115) shares this queue and nothing
     * else: it is dispatch's, it has its own interval, and it must appear and
     * disappear on that interval alone. Asserted here because this is where
     * the queue's schedulers can be read — and because the assertion above,
     * which pins the set exactly, is what would break if the two ever started
     * sharing a switch.
     */
    it('schedules the dispatch reconciler on its own interval, beside the sweeps', async () => {
      const both = await bootWith({
        MAINTENANCE_SWEEP_INTERVAL_MINUTES: '1440',
        DISPATCH_RECONCILE_INTERVAL_SECONDS: '3600',
      });
      try {
        expect(await schedulerIds()).toEqual([...MAINTENANCE_JOBS, DISPATCH_RECONCILE_JOB].sort());
      } finally {
        await both.close();
      }

      // The sweeps stay, the reconciler goes: two flags, two lifetimes.
      const reconcilerOff = await bootWith({
        MAINTENANCE_SWEEP_INTERVAL_MINUTES: '1440',
        DISPATCH_RECONCILE_INTERVAL_SECONDS: '0',
      });
      try {
        expect(await schedulerIds()).toEqual([...MAINTENANCE_JOBS].sort());
      } finally {
        await reconcilerOff.close();
      }
    }, 90_000);

    /**
     * The push-receipt sweep (#142) is the third tenant of this queue, and
     * the third with a switch of its own: it is `modules/notifications`'
     * code, it runs here because receipt polling is a clock rather than
     * because retention owns it, and it has to appear and disappear on
     * `PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS` alone.
     *
     * Worth asserting rather than assuming, because turning it off is a real
     * operational choice and "off" has to mean the scheduler is **removed** —
     * one left behind by an earlier release would keep retiring devices after
     * an operator believed they had stopped it.
     */
    it('schedules the push-receipt sweep on its own interval, beside the sweeps', async () => {
      const both = await bootWith({
        MAINTENANCE_SWEEP_INTERVAL_MINUTES: '1440',
        PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS: '3600',
      });
      try {
        expect(await schedulerIds()).toEqual([...MAINTENANCE_JOBS, PUSH_RECEIPT_SWEEP_JOB].sort());
      } finally {
        await both.close();
      }

      const receiptsOff = await bootWith({
        MAINTENANCE_SWEEP_INTERVAL_MINUTES: '1440',
        PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS: '0',
      });
      try {
        expect(await schedulerIds()).toEqual([...MAINTENANCE_JOBS].sort());
      } finally {
        await receiptsOff.close();
      }
    }, 90_000);
  });
});
