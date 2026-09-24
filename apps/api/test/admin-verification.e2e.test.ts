import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterDocument, MasterDocumentType, MasterDocumentUpload } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AdminMasterSummary } from '../src/modules/admin/admin-masters.types';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { AdminUserRow } from '../src/infra/database/schema/admin';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { MasterVerificationStatusName } from '../src/infra/database/schema/masters';
import type { UserRoleName } from '../src/infra/database/schema/users';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { MasterNotEligibleError, MastersService } from '../src/modules/masters/masters.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/admin/masters` over real HTTP, through the real `AppModule` graph — the
 * same construction as `master-verification.e2e.test.ts` and
 * `master-profile.e2e.test.ts`, which this file follows closely.
 *
 * There is no admin sign-in endpoint yet (ADR-0014 puts credential issuance in
 * EPIC 13), so this suite authenticates the way the ADR says the interim state
 * should be exercised: `AdminRepository.createAdmin` and
 * `AdminSessionService.start`, resolved straight from the Nest container, the
 * same pattern the other suites use for `UsersRepository`/`SessionsService`.
 *
 * What only this layer can prove: that every route under `/admin` is guarded
 * because of **where it lives**, not because of a decorator somebody
 * remembered (`admin.types.ts` § `isAdminRequest` names this file by name);
 * that the two token families reject each other's tokens in both directions;
 * that an admin session is re-checked against live database state on every
 * request rather than trusted from the token; that the `ALLOWED_FROM` table is
 * enforced exhaustively, including the one self-transition it allows; that
 * `admin_audit_log` is genuinely append-only and its action-shape CHECK
 * actually rejects a malformed verb; and that a suspended master is blocked
 * from `assertCanAcceptWork` even holding a token minted before the
 * suspension. None of that is visible from a unit test of a service against a
 * mocked repository.
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
 * therefore the only field that may legitimately differ between two responses
 * that must otherwise be indistinguishable. Copied from
 * `master-profile.e2e.test.ts`.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

/**
 * Real rate limits are shared, via Redis, across every run on this machine
 * and survive for an hour. `uploadAndConfirm` below drives the real
 * `document-upload` policy through `/masters/me/documents/presign`; overriding
 * every policy to an unreachable number under a fresh per-run key is the same
 * escape hatch `master-verification.e2e.test.ts` and `geocoding.e2e.test.ts`
 * take, for the same reason — the limit itself is somebody else's test to own.
 */
const UNREACHABLE = 1_000_000;
const WINDOW_MS = 3_600_000;
const testRateLimits: RateLimitConfig = {
  keySecret: `admin-verification-e2e-pepper-${randomUUID()}`,
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
    'price-range': {
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
    'device-registration': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'message-send': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'review-submit': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
  },
};

/** The five admin review actions, exactly as `admin-masters.service.ts` names them. */
type AdminAction = 'verify' | 'reject' | 'request_more' | 'suspend' | 'reinstate';

const ACTIONS: readonly AdminAction[] = [
  'verify',
  'reject',
  'request_more',
  'suspend',
  'reinstate',
];

const ALL_STATUSES: readonly MasterVerificationStatusName[] = [
  'pending_verification',
  'changes_requested',
  'rejected',
  'active',
  'suspended',
];

/**
 * `ALLOWED_FROM`, transcribed from `admin-masters.service.ts` — not guessed.
 * Any drift between this table and the implementation's is exactly what the
 * legal/illegal sweep below exists to catch.
 */
const ALLOWED_FROM: Readonly<Record<AdminAction, readonly MasterVerificationStatusName[]>> = {
  verify: ['pending_verification', 'changes_requested', 'rejected'],
  reject: ['pending_verification', 'changes_requested'],
  request_more: ['pending_verification', 'changes_requested'],
  suspend: ['pending_verification', 'changes_requested', 'rejected', 'active'],
  reinstate: ['suspended'],
};

const RESULTING_STATUS: Readonly<Record<AdminAction, MasterVerificationStatusName>> = {
  verify: 'active',
  reject: 'rejected',
  request_more: 'changes_requested',
  suspend: 'suspended',
  reinstate: 'active',
};

const REASON_REQUIRED: Readonly<Record<AdminAction, boolean>> = {
  verify: false,
  reject: true,
  request_more: true,
  suspend: true,
  reinstate: false,
};

/** One legal starting status per action — used where the test cares only about validation, not the transition. */
const LEGAL_STARTING_STATUS: Readonly<Record<AdminAction, MasterVerificationStatusName>> = {
  verify: 'pending_verification',
  reject: 'pending_verification',
  request_more: 'pending_verification',
  suspend: 'pending_verification',
  reinstate: 'suspended',
};

function actionSegment(action: AdminAction): string {
  return action === 'request_more' ? 'request-more' : action;
}

function actionPath(masterId: string, action: AdminAction): string {
  return `/admin/masters/${masterId}/${actionSegment(action)}`;
}

/** What `admin-masters.service.ts` actually writes as the audit verb — `master.${action.replace('_', '.')}`. */
function auditVerbFor(action: AdminAction): string {
  return `master.${action.replace('_', '.')}`;
}

function jpegBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}

interface AdminMasterListResponse {
  readonly items: AdminMasterSummary[];
  readonly nextCursor: string | null;
}

describe('admin review of master verification over HTTP (issue #39)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let adminRepository: AdminRepository;
  let adminSessionService: AdminSessionService;
  let mastersService: MastersService;
  let storage: StubStorageProvider;
  /** Every route Fastify actually registered, captured via `onRoute` before `app.init()` runs the resolvers. */
  let discoveredRoutes: { method: string; url: string }[];
  let adminRoutes: { method: string; url: string }[];
  /** One admin, shared by every test that does not need to poke its own session state. */
  let admin: { admin: AdminUserRow; accessToken: string; sessionId: string };

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

  async function signInAsMaster(): Promise<SignedIn> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Test' });
    expect(res.status).toBe(201);
    return caller;
  }

  async function newAdmin(): Promise<{
    admin: AdminUserRow;
    accessToken: string;
    sessionId: string;
  }> {
    const created = await adminRepository.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
    });
    const session = await adminSessionService.start(created.id);
    return { admin: created, accessToken: session.accessToken, sessionId: session.sessionId };
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

  /**
   * Any HTTP method, for walking the live route table generically — the
   * others above exist too because most call sites know their verb and
   * benefit from the narrower signature.
   */
  function requestFor(method: string, path: string, accessToken?: string) {
    const agent = request(app.getHttpServer());
    const pending = (() => {
      switch (method.toUpperCase()) {
        case 'GET':
          return agent.get(path);
        case 'POST':
          return agent.post(path);
        case 'PUT':
          return agent.put(path);
        case 'PATCH':
          return agent.patch(path);
        case 'DELETE':
          return agent.delete(path);
        case 'HEAD':
          return agent.head(path);
        case 'OPTIONS':
          return agent.options(path);
        default:
          throw new Error(`Unsupported method "${method}" discovered on the admin route table.`);
      }
    })();
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  /** Fills every `:param` segment of a route template with a well-formed, guaranteed-absent uuid. */
  function fillRouteParams(url: string): string {
    return url.replace(/:([A-Za-z0-9_]+)/g, () => unknownUuid());
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

  /**
   * Sets a master's verification status directly, bypassing the admin
   * transition path — the same construction `master-verification.e2e.test.ts`
   * uses to put a master into an arbitrary starting state before exercising
   * the endpoint actually under test. `suspended_at` is kept in step with
   * `masters_suspension_consistent`.
   */
  async function setVerificationStatus(
    masterId: string,
    status: MasterVerificationStatusName,
  ): Promise<void> {
    if (status === 'suspended') {
      await pool.query(
        `update masters set verification_status = $2, suspended_at = now() where id = $1`,
        [masterId, status],
      );
    } else {
      await pool.query(
        `update masters set verification_status = $2, suspended_at = null where id = $1`,
        [masterId, status],
      );
    }
  }

  async function createMasterAt(
    status: MasterVerificationStatusName,
  ): Promise<{ userId: string; masterId: string; accessToken: string }> {
    const caller = await signInAsMaster();
    const masterId = await masterIdFor(caller.userId);
    if (status !== 'pending_verification') {
      await setVerificationStatus(masterId, status);
    }
    return { userId: caller.userId, masterId, accessToken: caller.accessToken };
  }

  async function historyRowCount(masterId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from master_verification_history where master_id = $1',
      [masterId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function lastHistoryRow(masterId: string): Promise<{
    fromStatus: string;
    toStatus: string;
    actorKind: string;
    actorAdminId: string | null;
    actorUserId: string | null;
    reason: string | null;
  }> {
    const result = await pool.query<{
      fromStatus: string;
      toStatus: string;
      actorKind: string;
      actorAdminId: string | null;
      actorUserId: string | null;
      reason: string | null;
    }>(
      `select from_status as "fromStatus", to_status as "toStatus", actor_kind as "actorKind",
              actor_admin_id as "actorAdminId", actor_user_id as "actorUserId", reason
       from master_verification_history
       where master_id = $1
       order by created_at desc, id desc
       limit 1`,
      [masterId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no master_verification_history row for master ${masterId}`);
    }
    return row;
  }

  async function countAuditForTarget(targetType: string, targetId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from admin_audit_log where target_type = $1 and target_id = $2',
      [targetType, targetId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function lastAuditRow(
    targetType: string,
    targetId: string,
  ): Promise<{ action: string; reason: string | null; adminUserId: string }> {
    const result = await pool.query<{ action: string; reason: string | null; adminUserId: string }>(
      `select action, reason, admin_user_id as "adminUserId"
       from admin_audit_log
       where target_type = $1 and target_id = $2
       order by created_at desc, id desc
       limit 1`,
      [targetType, targetId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no admin_audit_log row for ${targetType} ${targetId}`);
    }
    return row;
  }

  async function documentReviewFields(
    documentId: string,
  ): Promise<{ status: string; reviewedByAdminId: string | null; reviewedAt: Date | null }> {
    const result = await pool.query<{
      status: string;
      reviewedByAdminId: string | null;
      reviewedAt: Date | null;
    }>(
      `select status, reviewed_by_admin_id as "reviewedByAdminId", reviewed_at as "reviewedAt"
       from master_documents
       where id = $1`,
      [documentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`no master_documents row for id ${documentId}`);
    }
    return row;
  }

  /** Presigns, uploads through the stub, and confirms one document — the minimum to get evidence into `pending_review`. */
  async function uploadAndConfirm(
    caller: SignedIn,
    documentType: MasterDocumentType,
  ): Promise<MasterDocument> {
    const presignRes = await post('/masters/me/documents/presign', caller.accessToken).send({
      documentType,
      contentType: 'image/jpeg',
    });
    expect(presignRes.status).toBe(201);
    const upload = presignRes.body as MasterDocumentUpload;

    const storageKeyResult = await pool.query<{ storage_key: string }>(
      'select storage_key from master_documents where id = $1',
      [upload.documentId],
    );
    const storageKey = storageKeyResult.rows[0]?.storage_key;
    if (storageKey === undefined) {
      throw new Error(`no storage key for document ${upload.documentId}`);
    }
    storage.putObject(storageKey, jpegBytes());

    const confirmRes = await post(
      `/masters/me/documents/${upload.documentId}/confirm`,
      caller.accessToken,
    );
    expect(confirmRes.status).toBe(201);
    return confirmRes.body as MasterDocument;
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(testRateLimits)
      .compile();

    // The adapter is built here, separately from `createNestApplication`, so
    // `onRoute` can be attached to the real Fastify instance BEFORE Nest's
    // route resolvers run during `app.init()`. This is what requirement 2
    // needs: a live enumeration of every route the app actually registered,
    // not a hand-maintained list this file could drift from.
    const adapter = new FastifyAdapter();
    discoveredRoutes = [];
    adapter.getInstance().addHook('onRoute', (routeOptions) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      for (const method of methods) {
        discoveredRoutes.push({ method, url: routeOptions.url });
      }
    });

    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // `isAdminRequest`'s own rule: the exact prefix or the prefix plus a
    // slash. Deduplicated, because Fastify fires `onRoute` once per method
    // and some routes (list) are hit twice already in that loop above.
    const seen = new Set<string>();
    adminRoutes = discoveredRoutes.filter((route) => {
      const isAdmin = route.url === '/admin' || route.url.startsWith('/admin/');
      if (!isAdmin) {
        return false;
      }
      const key = `${route.method} ${route.url}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    adminRepository = app.get(AdminRepository);
    adminSessionService = app.get(AdminSessionService);
    mastersService = app.get(MastersService);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pool = new Pool({ connectionString: database.url });
    // No `error` listener would mean a terminated backend surfaces as an
    // unhandled rejection — see the same note in `master-profile.e2e.test.ts`.
    pool.on('error', () => undefined);

    admin = await newAdmin();
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  describe('the whole /admin surface is guarded by its path, not by a decorator', () => {
    it('discovers at least the known admin/masters routes — a control on the harness itself', () => {
      // If this were ever zero, every assertion below would pass vacuously
      // and prove nothing. `admin.types.ts` documents this file as the place
      // that walks the live table; this is the check that it actually did.
      expect(adminRoutes.length).toBeGreaterThanOrEqual(9);
      const paths = adminRoutes.map((route) => `${route.method} ${route.url}`);
      expect(paths).toContain('GET /admin/masters');
      expect(paths).toContain('POST /admin/masters/:id/verify');
    });

    it('answers 401 with no token at all, for every route the app registered under /admin', async () => {
      for (const route of adminRoutes) {
        const res = await requestFor(route.method, fillRouteParams(route.url));
        expect(res.status, `${route.method} ${route.url} without a token`).toBe(401);
      }
    });

    it('answers 401 — not 403 — for a valid customer/master access token, on every /admin route', async () => {
      const customer = await signIn();
      for (const route of adminRoutes) {
        const res = await requestFor(
          route.method,
          fillRouteParams(route.url),
          customer.accessToken,
        );
        expect(res.status, `${route.method} ${route.url} with a consumer token`).toBe(401);
      }
    });

    it(
      'the no-token 401 and the consumer-token 401 are byte-identical envelopes (minus requestId) ' +
        '— the audience check gives no caller a way to tell "wrong token" from "no token"',
      async () => {
        const customer = await signIn();
        const withoutToken = await get('/admin/masters');
        const withConsumerToken = await get('/admin/masters', customer.accessToken);

        expect(withoutToken.status).toBe(401);
        expect(withConsumerToken.status).toBe(401);
        expect(envelopeWithoutRequestId(withoutToken.body)).toEqual(
          envelopeWithoutRequestId(withConsumerToken.body),
        );
      },
    );

    it('rejects an admin token on a consumer route — the separation goes both ways', async () => {
      const res = await get('/masters/me', admin.accessToken);
      expect(res.status).toBe(401);
    });
  });

  describe('an admin session is re-checked against current database state, every time', () => {
    it('answers 401 once the session has been revoked', async () => {
      const created = await newAdmin();
      expect((await get('/admin/masters', created.accessToken)).status).toBe(200);

      await adminSessionService.revoke(created.sessionId);

      expect((await get('/admin/masters', created.accessToken)).status).toBe(401);
    });

    it('answers 401 once the admin account has been disabled', async () => {
      const created = await newAdmin();
      await pool.query(`update admin_users set status = 'disabled' where id = $1`, [
        created.admin.id,
      ]);

      expect((await get('/admin/masters', created.accessToken)).status).toBe(401);
    });

    it('answers 401 once the session has expired', async () => {
      const created = await newAdmin();
      await pool.query(
        `update admin_sessions set expires_at = now() - interval '1 second' where id = $1`,
        [created.sessionId],
      );

      expect((await get('/admin/masters', created.accessToken)).status).toBe(401);
    });

    it('answers 401 once the session has been idle past the configured timeout', async () => {
      // The default idle timeout is 30 minutes (`ADMIN_SESSION_IDLE_TIMEOUT`);
      // an hour of inactivity is well past it without needing to touch
      // `process.env` before boot.
      const created = await newAdmin();
      await pool.query(
        `update admin_sessions set last_used_at = now() - interval '1 hour' where id = $1`,
        [created.sessionId],
      );

      expect((await get('/admin/masters', created.accessToken)).status).toBe(401);
    });
  });

  describe('every legal transition in ALLOWED_FROM, and every illegal one', () => {
    for (const action of ACTIONS) {
      const to = RESULTING_STATUS[action];
      const legalFrom = ALLOWED_FROM[action].filter((from) => from !== to);
      const selfTransitionFrom = ALLOWED_FROM[action].filter((from) => from === to);
      const illegalFrom = ALL_STATUSES.filter((status) => !ALLOWED_FROM[action].includes(status));

      describe(`action: ${action} (-> ${to})`, () => {
        for (const from of legalFrom) {
          it(`is allowed from ${from}, moves the master to ${to}, and records admin history`, async () => {
            const { masterId } = await createMasterAt(from);
            const reasonBody = REASON_REQUIRED[action] ? { reason: `Reason for ${action}.` } : {};
            const historyBefore = await historyRowCount(masterId);
            const auditBefore = await countAuditForTarget('master', masterId);

            const res = await post(actionPath(masterId, action), admin.accessToken).send(
              reasonBody,
            );

            expect(res.status).toBe(201);
            const body = res.body as AdminMasterSummary;
            expect(body.verificationStatus).toBe(to);
            expect(await verificationStatusFor(masterId)).toBe(to);

            expect(await historyRowCount(masterId)).toBe(historyBefore + 1);
            const history = await lastHistoryRow(masterId);
            expect(history.fromStatus).toBe(from);
            expect(history.toStatus).toBe(to);
            expect(history.actorKind).toBe('admin');
            expect(history.actorAdminId).toBe(admin.admin.id);
            expect(history.actorUserId).toBeNull();

            expect(await countAuditForTarget('master', masterId)).toBe(auditBefore + 1);
          });
        }

        for (const from of selfTransitionFrom) {
          it(
            `succeeds from ${from} (a status-to-itself request) with NO new history row — the ` +
              'table has no transition from a status to itself — but DOES append an audit row',
            async () => {
              const { masterId } = await createMasterAt(from);
              const reasonBody = REASON_REQUIRED[action] ? { reason: `Reason for ${action}.` } : {};
              const historyBefore = await historyRowCount(masterId);
              const auditBefore = await countAuditForTarget('master', masterId);

              const res = await post(actionPath(masterId, action), admin.accessToken).send(
                reasonBody,
              );

              expect(res.status).toBe(201);
              expect(await verificationStatusFor(masterId)).toBe(to);
              expect(await historyRowCount(masterId)).toBe(historyBefore);
              expect(await countAuditForTarget('master', masterId)).toBe(auditBefore + 1);
            },
          );
        }

        for (const from of illegalFrom) {
          it(`is rejected with 409 from ${from}, naming the illegal edge`, async () => {
            const { masterId } = await createMasterAt(from);
            const reasonBody = REASON_REQUIRED[action] ? { reason: `Reason for ${action}.` } : {};

            const res = await post(actionPath(masterId, action), admin.accessToken).send(
              reasonBody,
            );

            expect(res.status).toBe(409);
            const body = res.body as ErrorEnvelope;
            expect(body.error.code).toBe('CONFLICT');
            expect(body.error.details?.from).toBe(from);
            expect(body.error.details?.to).toBe(to);
            // And the status truly did not move.
            expect(await verificationStatusFor(masterId)).toBe(from);
          });
        }
      });
    }
  });

  /** The explicit version of requirement 8, in the exact terms it is stated. */
  it(
    'request-more on a master who is ALREADY changes_requested succeeds, writes no history row, ' +
      'but does write an admin_audit_log row',
    async () => {
      const { masterId } = await createMasterAt('changes_requested');
      const historyBefore = await historyRowCount(masterId);
      const auditBefore = await countAuditForTarget('master', masterId);

      const res = await post(actionPath(masterId, 'request_more'), admin.accessToken).send({
        reason: 'Please also upload a clearer selfie.',
      });

      expect(res.status).toBe(201);
      expect(await verificationStatusFor(masterId)).toBe('changes_requested');
      expect(await historyRowCount(masterId)).toBe(historyBefore);
      expect(await countAuditForTarget('master', masterId)).toBe(auditBefore + 1);
    },
  );

  describe('reason requirements', () => {
    for (const action of [
      'reject',
      'request_more',
      'suspend',
    ] as const satisfies readonly AdminAction[]) {
      it(`${action} answers 422 when the reason is missing`, async () => {
        const { masterId } = await createMasterAt(LEGAL_STARTING_STATUS[action]);
        const res = await post(actionPath(masterId, action), admin.accessToken).send({});
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      });

      it(`${action} answers 422 when the reason is empty or whitespace-only`, async () => {
        for (const reason of ['', '   ']) {
          const { masterId } = await createMasterAt(LEGAL_STARTING_STATUS[action]);
          const res = await post(actionPath(masterId, action), admin.accessToken).send({ reason });
          expect(res.status).toBe(422);
          expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
        }
      });
    }

    for (const action of ['verify', 'reinstate'] as const satisfies readonly AdminAction[]) {
      it(`${action} answers 422 when the body carries a reason — the DTO is a strict empty object`, async () => {
        const { masterId } = await createMasterAt(LEGAL_STARTING_STATUS[action]);
        const res = await post(actionPath(masterId, action), admin.accessToken).send({
          reason: 'Not allowed here.',
        });
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      });
    }
  });

  describe('every admin action writes admin_audit_log with the right verb, actor and reason', () => {
    for (const action of ACTIONS) {
      it(`records "${auditVerbFor(action)}" for ${action}, against this admin, with the reason it was given`, async () => {
        const { masterId } = await createMasterAt(LEGAL_STARTING_STATUS[action]);
        const reason = REASON_REQUIRED[action] ? `Reason for ${action}.` : undefined;
        const res = await post(actionPath(masterId, action), admin.accessToken).send(
          reason === undefined ? {} : { reason },
        );

        expect(res.status).toBe(201);
        const row = await lastAuditRow('master', masterId);
        expect(row.action).toBe(auditVerbFor(action));
        expect(row.adminUserId).toBe(admin.admin.id);
        expect(row.reason).toBe(reason ?? null);
      });
    }
  });

  describe('reads of personal data are audited too', () => {
    it('GET /admin/masters/:id records master.read', async () => {
      const { masterId } = await createMasterAt('pending_verification');

      const res = await get(`/admin/masters/${masterId}`, admin.accessToken);
      expect(res.status).toBe(200);

      const row = await lastAuditRow('master', masterId);
      expect(row.action).toBe('master.read');
      expect(row.adminUserId).toBe(admin.admin.id);
    });

    it('downloading a document records master.document.read — against the document, not the master', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      const document = await uploadAndConfirm(caller, 'id_card_front');

      const res = await get(
        `/admin/masters/${masterId}/documents/${document.id}/download`,
        admin.accessToken,
      );
      expect(res.status).toBe(200);

      const row = await lastAuditRow('master_document', document.id);
      expect(row.action).toBe('master.document.read');
      expect(row.adminUserId).toBe(admin.admin.id);
      // Not logged against the master — a different target entirely.
      expect(await countAuditForTarget('master', masterId)).toBe(0);
    });
  });

  describe('admin_audit_log is append-only and shape-checked', () => {
    it('rejects a raw UPDATE of a written audit row', async () => {
      const { masterId } = await createMasterAt('pending_verification');
      const verified = await post(actionPath(masterId, 'verify'), admin.accessToken).send({});
      expect(verified.status).toBe(201);

      await expect(
        pool.query(`update admin_audit_log set reason = 'x' where target_id = $1`, [masterId]),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects a raw DELETE of a written audit row', async () => {
      const { masterId } = await createMasterAt('pending_verification');
      const verified = await post(actionPath(masterId, 'verify'), admin.accessToken).send({});
      expect(verified.status).toBe(201);

      await expect(
        pool.query(`delete from admin_audit_log where target_id = $1`, [masterId]),
      ).rejects.toThrow(/append-only/);
    });

    it(
      'rejects an action that is not dot-separated (admin_audit_log_action_shape) — the ' +
        'separator is a literal dot, not "any character"',
      async () => {
        await expect(
          pool.query(
            `insert into admin_audit_log (id, admin_user_id, action, target_type, target_id, created_at)
             values ($1, $2, $3, $4, $5, now())`,
            [randomUUID(), admin.admin.id, 'masterXverify', 'master', unknownUuid()],
          ),
        ).rejects.toThrow(/admin_audit_log_action_shape|violates check constraint/);
      },
    );

    it('accepts a genuinely dot-separated action', async () => {
      await expect(
        pool.query(
          `insert into admin_audit_log (id, admin_user_id, action, target_type, target_id, created_at)
           values ($1, $2, $3, $4, $5, now())`,
          [randomUUID(), admin.admin.id, 'master.verify', 'master', unknownUuid()],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('document review side effects', () => {
    it('verify stamps every pending_review document accepted, with the reviewer and a timestamp', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      const document = await uploadAndConfirm(caller, 'id_card_front');

      const res = await post(`/admin/masters/${masterId}/verify`, admin.accessToken).send({});
      expect(res.status).toBe(201);

      const row = await documentReviewFields(document.id);
      expect(row.status).toBe('accepted');
      expect(row.reviewedByAdminId).toBe(admin.admin.id);
      expect(row.reviewedAt).not.toBeNull();
    });

    it('reject stamps every pending_review document rejected, with the reviewer and a timestamp', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      const document = await uploadAndConfirm(caller, 'id_card_front');

      const res = await post(`/admin/masters/${masterId}/reject`, admin.accessToken).send({
        reason: 'Photo is too blurry to read.',
      });
      expect(res.status).toBe(201);

      const row = await documentReviewFields(document.id);
      expect(row.status).toBe('rejected');
      expect(row.reviewedByAdminId).toBe(admin.admin.id);
      expect(row.reviewedAt).not.toBeNull();
    });

    it('request-more leaves documents exactly as they were — nothing was decided', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      const document = await uploadAndConfirm(caller, 'id_card_front');

      const res = await post(`/admin/masters/${masterId}/request-more`, admin.accessToken).send({
        reason: 'Please also add the back of the card.',
      });
      expect(res.status).toBe(201);

      const row = await documentReviewFields(document.id);
      expect(row.status).toBe('pending_review');
      expect(row.reviewedByAdminId).toBeNull();
      expect(row.reviewedAt).toBeNull();
    });
  });

  describe('suspension revokes the master’s sessions', () => {
    it(
      'revokes every session row for the suspended master, and their previously issued access ' +
        'token stops working on a consumer route',
      async () => {
        const caller = await signInAsMaster();
        const masterId = await masterIdFor(caller.userId);

        // Sanity check: the token works before suspension.
        expect((await get('/masters/me', caller.accessToken)).status).toBe(200);

        const res = await post(`/admin/masters/${masterId}/suspend`, admin.accessToken).send({
          reason: 'Reported by a customer for unsafe conduct.',
        });
        expect(res.status).toBe(201);

        const sessionRows = await pool.query<{ revoked_at: Date | null }>(
          'select revoked_at from sessions where user_id = $1',
          [caller.userId],
        );
        expect(sessionRows.rowCount).toBeGreaterThan(0);
        expect(sessionRows.rows.every((row) => row.revoked_at !== null)).toBe(true);

        // The SAME token, unchanged, minted before suspension — now refused.
        expect((await get('/masters/me', caller.accessToken)).status).toBe(401);
      },
    );
  });

  describe('MastersService.assertCanAcceptWork — a suspended master cannot accept work, even with a pre-suspension token', () => {
    it('rejects with 409 for a suspended master, naming the status', async () => {
      const { masterId } = await createMasterAt('suspended');

      await expect(mastersService.assertCanAcceptWork(masterId)).rejects.toBeInstanceOf(
        MasterNotEligibleError,
      );
      await expect(mastersService.assertCanAcceptWork(masterId)).rejects.toMatchObject({
        status: 409,
        details: { verificationStatus: 'suspended' },
      });
    });

    it('rejects with 409 for a master still pending_verification', async () => {
      const { masterId } = await createMasterAt('pending_verification');

      await expect(mastersService.assertCanAcceptWork(masterId)).rejects.toMatchObject({
        status: 409,
        details: { verificationStatus: 'pending_verification' },
      });
    });

    it('resolves for an active master', async () => {
      const { masterId } = await createMasterAt('active');

      await expect(mastersService.assertCanAcceptWork(masterId)).resolves.toBeDefined();
    });

    it('answers 404 for a soft-deleted master — there is nobody to verify', async () => {
      const caller = await signInAsMaster();
      const masterId = await masterIdFor(caller.userId);
      expect((await del('/masters/me', caller.accessToken)).status).toBe(204);

      await expect(mastersService.assertCanAcceptWork(masterId)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('GET /admin/masters — the review queue', () => {
    it('filters by status: every returned item carries the requested status, and none of the excluded ones leak in', async () => {
      const matching = await createMasterAt('changes_requested');
      const excluded = await createMasterAt('active');

      const res = await get('/admin/masters?status=changes_requested&limit=100', admin.accessToken);

      expect(res.status).toBe(200);
      const body = res.body as AdminMasterListResponse;
      expect(body.items.every((item) => item.verificationStatus === 'changes_requested')).toBe(
        true,
      );
      expect(body.items.map((item) => item.id)).toContain(matching.masterId);
      expect(body.items.map((item) => item.id)).not.toContain(excluded.masterId);
    });

    it(
      'paginates with limit and cursor: paging through every changes_requested master in twos ' +
        'visits each one exactly once, and never repeats a row',
      async () => {
        // Sequential, not `Promise.all` — five concurrent sign-in/create/HTTP
        // chains showed a transient `ECONNRESET` under load in this suite's
        // full run. The property under test is about pagination correctness,
        // not creation concurrency, so there is nothing to gain from racing
        // them and a flake to lose by doing so.
        const created: { userId: string; masterId: string; accessToken: string }[] = [];
        for (let i = 0; i < 5; i += 1) {
          created.push(await createMasterAt('changes_requested'));
        }

        const seenIds: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        for (;;) {
          pages += 1;
          // A hard ceiling on the loop, so a broken cursor produces a failing
          // assertion instead of a test that hangs the whole suite.
          expect(pages).toBeLessThan(1000);

          const query =
            cursor === undefined
              ? '/admin/masters?status=changes_requested&limit=2'
              : `/admin/masters?status=changes_requested&limit=2&cursor=${cursor}`;
          const res = await get(query, admin.accessToken);
          expect(res.status).toBe(200);
          const body = res.body as AdminMasterListResponse;
          expect(body.items.length).toBeLessThanOrEqual(2);

          for (const item of body.items) {
            expect(item.verificationStatus).toBe('changes_requested');
            seenIds.push(item.id);
          }

          if (body.nextCursor === null) {
            break;
          }
          cursor = body.nextCursor;
        }

        // No id visited twice across the whole traversal — the property that
        // catches both "skipped a row" and "repeated a row" at once.
        expect(new Set(seenIds).size).toBe(seenIds.length);
        for (const master of created) {
          expect(seenIds).toContain(master.masterId);
        }
      },
    );

    it('answers 422 for an unknown status value', async () => {
      const res = await get('/admin/masters?status=not_a_real_status', admin.accessToken);
      expect(res.status).toBe(422);
    });

    it('answers 422 for limit=0 and for limit=101', async () => {
      const zero = await get('/admin/masters?limit=0', admin.accessToken);
      const tooLarge = await get('/admin/masters?limit=101', admin.accessToken);
      expect(zero.status).toBe(422);
      expect(tooLarge.status).toBe(422);
    });
  });

  describe('404 for a master id that does not exist', () => {
    it('on GET detail', async () => {
      const res = await get(`/admin/masters/${unknownUuid()}`, admin.accessToken);
      expect(res.status).toBe(404);
    });

    it('on the document download', async () => {
      const res = await get(
        `/admin/masters/${unknownUuid()}/documents/${unknownUuid()}/download`,
        admin.accessToken,
      );
      expect(res.status).toBe(404);
    });

    for (const action of ACTIONS) {
      it(`on ${action}`, async () => {
        const reasonBody = REASON_REQUIRED[action] ? { reason: 'Some reason.' } : {};
        const res = await post(actionPath(unknownUuid(), action), admin.accessToken).send(
          reasonBody,
        );
        expect(res.status).toBe(404);
      });
    }
  });
});
