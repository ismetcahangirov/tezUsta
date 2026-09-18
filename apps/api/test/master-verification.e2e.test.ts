import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  MasterDocument,
  MasterDocumentDownload,
  MasterDocumentType,
  MasterDocumentUpload,
  MasterVerificationSubmission,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { UserRoleName } from '../src/infra/database/schema/users';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/masters/me/documents*` and `/masters/me/verification/submit` over real
 * HTTP, through the real `AppModule` graph — the same construction as
 * `master-profile.e2e.test.ts`, which this file follows closely.
 *
 * The **object storage boundary** is the one thing this suite mocks
 * (`docs/engineering/testing-strategy.md` § Mocking: HTTP transport, SMS,
 * maps — "never the database in an integration test"). `STORAGE_PROVIDER`
 * defaults to `stub` (`test/setup-env.ts` leaves it unset), so the app is
 * wired to a real, in-process `StubStorageProvider`, resolved from the Nest
 * container the same way the test drives the client's PUT: `putObject` is
 * not part of `StorageProvider` and exists on the stub for exactly this.
 *
 * What only this layer can prove: that every route actually sits behind
 * authentication and the `master` role, that the API never receives or
 * returns the bytes or the storage key, that the size cap and the magic-byte
 * sniff are enforced against the real object at confirm — not the declared
 * `Content-Type` — and that a rejected upload does not survive the request
 * that rejected it, that a presigned URL is single-use, that replacing a
 * document supersedes rather than duplicates, that another master's document
 * id answers 404 rather than 403, and that `master_verification_history` is
 * genuinely append-only at the database level. None of that is visible from
 * a unit test of the service against a mocked repository.
 */

/** `users.phone_e164` is unique among live rows — see `master-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid but never-issued uuid — well-formed, guaranteed absent. */
function unknownUuid(): string {
  return randomUUID();
}

/**
 * The error envelope minus its `requestId` — fresh per request by design, and
 * therefore the only field that may legitimately differ between two
 * responses that must otherwise be indistinguishable. Copied from
 * `master-profile.e2e.test.ts`.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

/**
 * Real rate limits are shared, via Redis, across every run on this machine
 * and survive for an hour. `presign` carries the only `@RateLimit` in this
 * module (`document-upload`); overriding all five policies to effectively
 * unreachable numbers, under a fresh per-run key, is the same escape hatch
 * `geocoding.e2e.test.ts` and `auth.otp.e2e.test.ts` take, for the same
 * reason — the limit itself is somebody else's test to own.
 */
const UNREACHABLE = 1_000_000;
const WINDOW_MS = 3_600_000;
const testRateLimits: RateLimitConfig = {
  keySecret: `master-verification-e2e-pepper-${randomUUID()}`,
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
<<<<<<< HEAD
    'order-creation': {
=======
    'price-range': {
>>>>>>> origin/feat/84-indicative-price-range
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
  },
};

/**
 * The size cap this suite runs under — the schema's own floor
 * (`env.schema.ts` bounds `VERIFICATION_DOCUMENT_MAX_BYTES` at 64 KiB), set
 * BEFORE the app boots so the real, validated `AppConfig` carries it
 * (`ConfigModule` parses `process.env` once, at instantiation — the same note
 * `geocoding.e2e.test.ts` makes about `GOOGLE_MAPS_SERVER_API_KEY`). Small
 * enough that the "oversized" test builds its object cheaply; the default
 * 5 MiB would make the same test allocate megabytes for no reason.
 */
const TEST_MAX_BYTES = 64 * 1024;

type ContentType = 'image/jpeg' | 'image/png' | 'image/webp';

const REQUIRED_DOCUMENT_TYPES: readonly MasterDocumentType[] = [
  'id_card_front',
  'id_card_back',
  'selfie_with_id',
];

/** The exact wire shape of `MasterDocument` (`packages/types/src/master-document.ts`). */
const MASTER_DOCUMENT_FIELDS = [
  'createdAt',
  'documentType',
  'id',
  'sizeBytes',
  'status',
  'submittedAt',
  'updatedAt',
].sort();

/** The exact wire shape of `MasterDocumentUpload`. */
const MASTER_DOCUMENT_UPLOAD_FIELDS = [
  'contentType',
  'documentId',
  'expiresAt',
  'maxBytes',
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

function webpBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(Math.max(size, 12));
  buffer.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  buffer.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
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
    case 'image/webp':
      return webpBytes(size);
  }
}

describe('master verification document endpoints over HTTP (issue #38)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalMaxBytes: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let storage: StubStorageProvider;

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  async function signIn(roles: readonly UserRoleName[] = []): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    // Sanity check on the harness itself — see `master-profile.e2e.test.ts`.
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return { userId: created.user.id, accessToken: pair.accessToken };
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

  function del(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).delete(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  /** Signs in a fresh user and creates a master profile for it in one step. */
  async function signInAsMaster(): Promise<SignedIn> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Sabina' });
    expect(res.status).toBe(201);
    return caller;
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

  async function storageKeyFor(documentId: string): Promise<string> {
    const result = await pool.query<{ storage_key: string }>(
      'select storage_key from master_documents where id = $1',
      [documentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no master_documents row for id ${documentId}`);
    }
    return row.storage_key;
  }

  async function documentRowExists(documentId: string): Promise<boolean> {
    const result = await pool.query('select 1 from master_documents where id = $1', [documentId]);
    return (result.rowCount ?? 0) > 0;
  }

  async function documentStatus(documentId: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      'select status from master_documents where id = $1',
      [documentId],
    );
    return result.rows[0]?.status;
  }

  async function documentTypeRowCount(masterId: string, documentType: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from master_documents where master_id = $1 and document_type = $2',
      [masterId, documentType],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function historyRowCount(masterId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from master_verification_history where master_id = $1',
      [masterId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function verificationStatusFor(masterId: string): Promise<string> {
    const result = await pool.query<{ verification_status: string }>(
      'select verification_status from masters where id = $1',
      [masterId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no masters row for id ${masterId}`);
    }
    return row.verification_status;
  }

  async function setVerificationStatus(
    masterId: string,
    status: 'suspended' | 'rejected' | 'changes_requested' | 'active',
  ): Promise<void> {
    if (status === 'suspended') {
      await pool.query(
        `update masters set verification_status = $2, suspended_at = now() where id = $1`,
        [masterId, status],
      );
    } else {
      await pool.query(`update masters set verification_status = $2 where id = $1`, [
        masterId,
        status,
      ]);
    }
  }

  /** Presigns, uploads through the stub, and confirms one document. Returns the confirmed body. */
  async function uploadAndConfirm(
    caller: SignedIn,
    documentType: MasterDocumentType,
    options: { contentType?: ContentType; sizeBytes?: number } = {},
  ): Promise<MasterDocument> {
    const contentType = options.contentType ?? 'image/jpeg';
    const sizeBytes = options.sizeBytes ?? 16;

    const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
      documentType,
      contentType,
    });
    expect(presignRes.status).toBe(201);
    const upload = presignRes.body as MasterDocumentUpload;

    const storageKey = await storageKeyFor(upload.documentId);
    storage.putObject(storageKey, imageBytesFor(contentType, sizeBytes));

    const confirmRes = await post(
      `/masters/me/documents/${upload.documentId}/confirm`,
      caller.accessToken,
    );
    expect(confirmRes.status).toBe(201);
    return confirmRes.body as MasterDocument;
  }

  async function uploadAllRequiredDocuments(caller: SignedIn): Promise<void> {
    for (const documentType of REQUIRED_DOCUMENT_TYPES) {
      await uploadAndConfirm(caller, documentType);
    }
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Point the real `ConfigModule` at the throwaway database rather than
    // overriding `DATABASE_CONNECTION`, so the wiring under test is the
    // application's own — see the same note in `master-profile.e2e.test.ts`.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    originalMaxBytes = process.env.VERIFICATION_DOCUMENT_MAX_BYTES;
    process.env.VERIFICATION_DOCUMENT_MAX_BYTES = String(TEST_MAX_BYTES);

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
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pool = new Pool({ connectionString: database.url });
    // No `error` listener would mean a terminated backend surfaces as an
    // unhandled rejection — see the same note in `master-profile.e2e.test.ts`.
    pool.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalMaxBytes === undefined) {
      delete process.env.VERIFICATION_DOCUMENT_MAX_BYTES;
    } else {
      process.env.VERIFICATION_DOCUMENT_MAX_BYTES = originalMaxBytes;
    }
    await database.drop();
  });

  describe('POST /masters/me/documents/presign', () => {
    it('requires authentication', async () => {
      const res = await post('/masters/me/documents/presign').send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });
      expect(res.status).toBe(401);
    });

    it('answers 403 for an authenticated caller who never created a master profile', async () => {
      const caller = await signIn();

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it('mints an upload url exposing exactly the documented wire shape, with no storage key', async () => {
      const caller = await signInAsMaster();

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(201);
      const body = res.body as MasterDocumentUpload;
      expect(Object.keys(body).sort()).toEqual(MASTER_DOCUMENT_UPLOAD_FIELDS);
      expect(typeof body.documentId).toBe('string');
      expect(body.contentType).toBe('image/jpeg');
      expect(body.maxBytes).toBe(TEST_MAX_BYTES);
      expect(Date.parse(body.expiresAt)).not.toBeNaN();
      // No key or bucket path anywhere in the response, stringified whole —
      // the storage key this document was assigned is only ever readable
      // from the database, never from the API (`master-verification.service.ts`
      // § "Keys are server-generated").
      const storageKey = await storageKeyFor(body.documentId);
      expect(JSON.stringify(body)).not.toContain(storageKey);
    });

    it('rejects a disallowed content type — the allow-list fails closed', async () => {
      const caller = await signInAsMaster();

      for (const contentType of ['image/gif', 'application/pdf', 'image/svg+xml']) {
        const res = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType,
        });

        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects an unknown document type', async () => {
      const caller = await signInAsMaster();

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'passport',
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signInAsMaster();

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('is blocked with 409 CONFLICT for a suspended master', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      await setVerificationStatus(masterId, 'suspended');

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it('is blocked with 409 CONFLICT for a rejected master — rejection is not a resubmission path', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      await setVerificationStatus(masterId, 'rejected');

      const res = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });
  });

  describe('POST /masters/me/documents/:id/confirm', () => {
    it('requires authentication', async () => {
      const res = await post(`/masters/me/documents/${unknownUuid()}/confirm`);
      expect(res.status).toBe(401);
    });

    it(
      'turns an uploaded image into evidence: the document is pending review, with a real ' +
        'size and a submission time, and no server-only field leaks',
      async () => {
        const caller = await signInAsMaster();

        const confirmed = await uploadAndConfirm(caller, 'id_card_front', { sizeBytes: 1024 });

        expect(Object.keys(confirmed).sort()).toEqual(MASTER_DOCUMENT_FIELDS);
        expect(confirmed.status).toBe('pending_review');
        expect(confirmed.sizeBytes).toBe(1024);
        expect(confirmed.submittedAt).not.toBeNull();
        expect(Date.parse(confirmed.submittedAt as string)).not.toBeNaN();

        const list = (await get('/masters/me/documents', caller.accessToken))
          .body as MasterDocument[];
        const listed = list.find((doc) => doc.id === confirmed.id);
        expect(listed).toBeDefined();
        expect(listed?.status).toBe('pending_review');
        expect(listed?.sizeBytes).toBe(1024);
        expect(listed?.submittedAt).not.toBeNull();
      },
    );

    it(
      'rejects content whose magic bytes contradict the declared type, deletes the object, ' +
        'but keeps the row in awaiting_upload — the presigned url is not spent by a rejection',
      async () => {
        const caller = await signInAsMaster();

        const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/png',
        });
        const upload = presignRes.body as MasterDocumentUpload;
        const storageKey = await storageKeyFor(upload.documentId);
        // Declared PNG; the bytes that actually arrive are a JPEG.
        storage.putObject(storageKey, jpegBytes());

        const confirmRes = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );

        expect(confirmRes.status).toBe(422);
        expect((confirmRes.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
        expect(storage.hasObject(storageKey)).toBe(false);
        // The row survives the rejection: storage has no idea a confirm ever
        // happened, so deleting it here would leave a still-live presigned
        // url pointing at a key nothing references any more
        // (`master-verification.service.ts` § `discard`).
        expect(await documentRowExists(upload.documentId)).toBe(true);
        expect(await documentStatus(upload.documentId)).toBe('awaiting_upload');
      },
    );

    it(
      'lets the master retry on the SAME presigned url with a correctly-typed photo after a ' +
        'rejected confirm',
      async () => {
        const caller = await signInAsMaster();

        const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/png',
        });
        const upload = presignRes.body as MasterDocumentUpload;
        const storageKey = await storageKeyFor(upload.documentId);

        // First attempt: declared PNG, actually a JPEG — rejected.
        storage.putObject(storageKey, jpegBytes());
        const rejected = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );
        expect(rejected.status).toBe(422);

        // Retry: the SAME document id and the SAME storage key, now holding
        // bytes that actually match what was declared.
        storage.putObject(storageKey, pngBytes());
        const confirmed = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );

        expect(confirmed.status).toBe(201);
        expect((confirmed.body as MasterDocument).status).toBe('pending_review');
      },
    );

    it(
      're-presigning the same type after a rejected confirm still succeeds — the abandoned ' +
        'row and its object are cleared first',
      async () => {
        const caller = await signInAsMaster();

        const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/png',
        });
        const upload = presignRes.body as MasterDocumentUpload;
        const storageKey = await storageKeyFor(upload.documentId);
        storage.putObject(storageKey, jpegBytes());
        const rejected = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );
        expect(rejected.status).toBe(422);

        const retryRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/png',
        });

        expect(retryRes.status).toBe(201);
        const retryUpload = retryRes.body as MasterDocumentUpload;
        expect(retryUpload.documentId).not.toBe(upload.documentId);
        expect(await documentRowExists(upload.documentId)).toBe(false);
      },
    );

    it(
      'rejects bytes that are not a recognised image at all, deletes the object, but keeps ' +
        'the row in awaiting_upload',
      async () => {
        const caller = await signInAsMaster();

        const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/jpeg',
        });
        const upload = presignRes.body as MasterDocumentUpload;
        const storageKey = await storageKeyFor(upload.documentId);
        storage.putObject(storageKey, htmlBytes());

        const confirmRes = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );

        expect(confirmRes.status).toBe(422);
        expect((confirmRes.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
        expect(storage.hasObject(storageKey)).toBe(false);
        expect(await documentStatus(upload.documentId)).toBe('awaiting_upload');
      },
    );

    it(
      'rejects an object over the configured size cap, naming both numbers, deletes the ' +
        'object, but keeps the row in awaiting_upload',
      async () => {
        const caller = await signInAsMaster();

        const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/jpeg',
        });
        const upload = presignRes.body as MasterDocumentUpload;
        const storageKey = await storageKeyFor(upload.documentId);
        const oversizeBytes = TEST_MAX_BYTES + 1;
        storage.putObject(storageKey, jpegBytes(oversizeBytes));

        const confirmRes = await post(
          `/masters/me/documents/${upload.documentId}/confirm`,
          caller.accessToken,
        );

        expect(confirmRes.status).toBe(422);
        const body = confirmRes.body as ErrorEnvelope;
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(body.error.details?.maxBytes).toBe(TEST_MAX_BYTES);
        expect(body.error.details?.sizeBytes).toBe(oversizeBytes);
        expect(storage.hasObject(storageKey)).toBe(false);
        expect(await documentStatus(upload.documentId)).toBe('awaiting_upload');
      },
    );

    it('answers 409 CONFLICT when confirm is called before anything was uploaded', async () => {
      const caller = await signInAsMaster();
      const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });
      const upload = presignRes.body as MasterDocumentUpload;

      const res = await post(
        `/masters/me/documents/${upload.documentId}/confirm`,
        caller.accessToken,
      );

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it('answers 409 CONFLICT on a second confirm of the same document', async () => {
      const caller = await signInAsMaster();
      const confirmed = await uploadAndConfirm(caller, 'id_card_front');

      const res = await post(`/masters/me/documents/${confirmed.id}/confirm`, caller.accessToken);

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });
  });

  describe('GET /masters/me/documents', () => {
    it('requires authentication', async () => {
      const res = await get('/masters/me/documents');
      expect(res.status).toBe(401);
    });

    it('answers 403 for an authenticated caller who never created a master profile', async () => {
      const caller = await signIn();

      const res = await get('/masters/me/documents', caller.accessToken);

      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it(
      'replacing a document keeps exactly one live row of that type, while the superseded ' +
        'row survives in the table',
      async () => {
        const caller = await signInAsMaster();
        const masterId = await masterIdFor(caller.userId);

        const first = await uploadAndConfirm(caller, 'id_card_front');
        const second = await uploadAndConfirm(caller, 'id_card_front');
        expect(second.id).not.toBe(first.id);

        const list = (await get('/masters/me/documents', caller.accessToken))
          .body as MasterDocument[];
        const live = list.filter((doc) => doc.documentType === 'id_card_front');
        expect(live).toHaveLength(1);
        expect(live[0]?.id).toBe(second.id);

        expect(await documentTypeRowCount(masterId, 'id_card_front')).toBe(2);
      },
    );
  });

  describe('GET /masters/me/documents/:id/download', () => {
    it('requires authentication', async () => {
      const res = await get(`/masters/me/documents/${unknownUuid()}/download`);
      expect(res.status).toBe(401);
    });

    it('answers 404 before the document has been confirmed — there is nothing behind the key yet', async () => {
      const caller = await signInAsMaster();
      const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });
      const upload = presignRes.body as MasterDocumentUpload;

      const res = await get(
        `/masters/me/documents/${upload.documentId}/download`,
        caller.accessToken,
      );

      expect(res.status).toBe(404);
    });

    it('returns a short-lived read url once the document is confirmed', async () => {
      const caller = await signInAsMaster();
      const confirmed = await uploadAndConfirm(caller, 'id_card_front');

      const res = await get(`/masters/me/documents/${confirmed.id}/download`, caller.accessToken);

      expect(res.status).toBe(200);
      const body = res.body as MasterDocumentDownload;
      expect(typeof body.url).toBe('string');
      expect(body.url.length).toBeGreaterThan(0);
      expect(Date.parse(body.expiresAt)).not.toBeNaN();
    });
  });

  describe('DELETE /masters/me/documents/:id', () => {
    it('requires authentication', async () => {
      const res = await del(`/masters/me/documents/${unknownUuid()}`);
      expect(res.status).toBe(401);
    });

    it(
      'withdraws a document: 204, gone from the list, its object removed from storage since ' +
        'nobody reviewed it, and a second withdraw of the same id is 404',
      async () => {
        const caller = await signInAsMaster();
        const confirmed = await uploadAndConfirm(caller, 'id_card_front');
        const storageKey = await storageKeyFor(confirmed.id);

        const first = await del(`/masters/me/documents/${confirmed.id}`, caller.accessToken);
        expect(first.status).toBe(204);
        expect(first.text).toBe('');

        const list = (await get('/masters/me/documents', caller.accessToken))
          .body as MasterDocument[];
        expect(list.map((doc) => doc.id)).not.toContain(confirmed.id);
        expect(storage.hasObject(storageKey)).toBe(false);

        const second = await del(`/masters/me/documents/${confirmed.id}`, caller.accessToken);
        expect(second.status).toBe(404);
      },
    );
  });

  describe('re-presigning an abandoned upload', () => {
    it('clears the previous unused row, so the abandoned document id no longer exists', async () => {
      const caller = await signInAsMaster();

      const first = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });
      const firstUpload = first.body as MasterDocumentUpload;

      const second = await post('/masters/me/documents/presign', caller.accessToken).send({
        documentType: 'id_card_front',
        contentType: 'image/jpeg',
      });

      expect(second.status).toBe(201);
      const secondUpload = second.body as MasterDocumentUpload;
      expect(secondUpload.documentId).not.toBe(firstUpload.documentId);
      expect(await documentRowExists(firstUpload.documentId)).toBe(false);
    });
  });

  describe('cross-master access', () => {
    it(
      'answers 404 — not 403 — for confirm, download and delete of another master’s document, ' +
        'with a body byte-identical to a genuinely unknown id',
      async () => {
        // The whole control: a 403 here would confirm the id belongs to
        // *someone*, which would let a stranger enumerate real documents by
        // walking ids. A 404 that differs in any byte from the 404 for an id
        // nobody ever used is the same leak in a smaller disguise — see the
        // identical comment in `master-profile.e2e.test.ts`.
        const owner = await signInAsMaster();
        const presignRes = await post('/masters/me/documents/presign', owner.accessToken).send({
          documentType: 'id_card_front',
          contentType: 'image/jpeg',
        });
        const ownerDocumentId = (presignRes.body as MasterDocumentUpload).documentId;

        const stranger = await signInAsMaster();

        const confirmNotYours = await post(
          `/masters/me/documents/${ownerDocumentId}/confirm`,
          stranger.accessToken,
        );
        const confirmNeverExisted = await post(
          `/masters/me/documents/${unknownUuid()}/confirm`,
          stranger.accessToken,
        );
        expect(confirmNotYours.status).toBe(404);
        expect(confirmNeverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(confirmNotYours.body)).toEqual(
          envelopeWithoutRequestId(confirmNeverExisted.body),
        );

        const downloadNotYours = await get(
          `/masters/me/documents/${ownerDocumentId}/download`,
          stranger.accessToken,
        );
        const downloadNeverExisted = await get(
          `/masters/me/documents/${unknownUuid()}/download`,
          stranger.accessToken,
        );
        expect(downloadNotYours.status).toBe(404);
        expect(downloadNeverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(downloadNotYours.body)).toEqual(
          envelopeWithoutRequestId(downloadNeverExisted.body),
        );

        const deleteNotYours = await del(
          `/masters/me/documents/${ownerDocumentId}`,
          stranger.accessToken,
        );
        const deleteNeverExisted = await del(
          `/masters/me/documents/${unknownUuid()}`,
          stranger.accessToken,
        );
        expect(deleteNotYours.status).toBe(404);
        expect(deleteNeverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(deleteNotYours.body)).toEqual(
          envelopeWithoutRequestId(deleteNeverExisted.body),
        );

        // And the owner's own presign survived every one of the stranger's
        // attempts — none of them was actually able to touch it.
        expect(await documentRowExists(ownerDocumentId)).toBe(true);
      },
    );
  });

  describe('POST /masters/me/verification/submit', () => {
    it('requires authentication', async () => {
      const res = await post('/masters/me/verification/submit');
      expect(res.status).toBe(401);
    });

    it('answers 409, naming exactly the document types still missing', async () => {
      const caller = await signInAsMaster();
      await uploadAndConfirm(caller, 'id_card_front');
      await uploadAndConfirm(caller, 'id_card_back');
      // selfie_with_id deliberately never uploaded.

      const res = await post('/masters/me/verification/submit', caller.accessToken);

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details?.missingDocumentTypes).toEqual(['selfie_with_id']);
    });

    it(
      'submits once all three required documents are present, moving the master back into ' +
        'the review queue',
      async () => {
        const caller = await signInAsMaster();
        const masterId = await masterIdFor(caller.userId);
        await setVerificationStatus(masterId, 'changes_requested');
        await uploadAllRequiredDocuments(caller);

        const res = await post('/masters/me/verification/submit', caller.accessToken);

        expect(res.status).toBe(201);
        const body = res.body as MasterVerificationSubmission;
        expect(body).toEqual({ submitted: true, missingDocumentTypes: [] });
        expect(await verificationStatusFor(masterId)).toBe('pending_verification');
      },
    );

    it('is idempotent: submitting again while already pending_verification still answers 200-series success', async () => {
      const caller = await signInAsMaster();
      await uploadAllRequiredDocuments(caller);
      // A fresh master profile already starts `pending_verification`
      // (`masters.service.ts`), so this first submit makes no transition at
      // all — which is exactly the branch this test exercises.
      const first = await post('/masters/me/verification/submit', caller.accessToken);
      expect(first.status).toBe(201);

      const second = await post('/masters/me/verification/submit', caller.accessToken);

      expect(second.status).toBe(201);
      expect(second.body as MasterVerificationSubmission).toEqual({
        submitted: true,
        missingDocumentTypes: [],
      });
    });
  });

  describe('master_verification_history is append-only', () => {
    /** Produces one real transition row: `changes_requested` → `pending_verification`. */
    async function masterWithHistoryRow(): Promise<string> {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      await setVerificationStatus(masterId, 'changes_requested');
      await uploadAllRequiredDocuments(caller);

      const res = await post('/masters/me/verification/submit', caller.accessToken);
      expect(res.status).toBe(201);
      expect(await historyRowCount(masterId)).toBeGreaterThan(0);
      return masterId;
    }

    it('rejects a raw UPDATE on a written history row', async () => {
      const masterId = await masterWithHistoryRow();

      await expect(
        pool.query(`update master_verification_history set reason = 'x' where master_id = $1`, [
          masterId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects a raw DELETE of a written history row', async () => {
      const masterId = await masterWithHistoryRow();

      await expect(
        pool.query(`delete from master_verification_history where master_id = $1`, [masterId]),
      ).rejects.toThrow(/append-only/);
    });
  });
});
