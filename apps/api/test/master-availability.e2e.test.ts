import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterAvailability } from '@tezusta/types';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { presenceKey } from '../src/infra/presence/master-presence.service';
import { runMigrations } from '../src/infra/database/migrate';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/masters/me/availability` over real HTTP, through the real `AppModule`
 * graph — the same construction as `master-profile.e2e.test.ts`, which this
 * file follows closely.
 *
 * What only this layer can prove: that going online is actually gated on
 * `MastersService.assertCanAcceptWork` re-read from the database rather than
 * from a cached actor; that the stored intent (`masters.is_available`) and the
 * Redis liveness key really are two independent facts that can diverge — the
 * headline acceptance criterion of issue #40 — rather than one boolean
 * dressed up as two; that a heartbeat re-checks eligibility and drops a master
 * suspended mid-shift within one beat; and that the presence key is genuinely
 * gone from Redis, not merely reported as gone, the moment a master goes
 * offline or is dropped. None of that is visible from a unit test of the
 * service against a mocked presence store.
 *
 * `PRESENCE_TTL_SECONDS` / `PRESENCE_HEARTBEAT_SECONDS` are overridden to the
 * schema's own floor — 30s / 10s, the smallest pair `env.schema.ts`'s
 * `superRefine` allows (TTL at least twice the heartbeat) — before the app
 * boots, the same `process.env` trick `master-profile.e2e.test.ts` uses for
 * `DATABASE_URL`. `ConfigModule` reads `process.env` exactly once, so this has
 * to happen before `Test.createTestingModule(...).compile()`.
 */

/** `users.phone_e164` is unique among live rows — see `master-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

/**
 * The exact Redis key `MasterPresenceService` writes — imported, not guessed,
 * so the key layout and this run's namespace (#125) have one definition
 * between the application and this suite.
 */
function keyFor(masterId: string): string {
  return presenceKey(parseEnv(process.env).redis.keyPrefix, masterId);
}

const PRESENCE_TTL_SECONDS = 30;
const PRESENCE_HEARTBEAT_SECONDS = 10;

describe('master availability and presence endpoints over HTTP (issue #40)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalTtl: string | undefined;
  let originalHeartbeat: string | undefined;
  let pool: Pool;
  let redis: Redis;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  interface SignedInMaster extends SignedIn {
    readonly masterId: string;
  }

  async function signIn(roles: readonly UserRoleName[] = []): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    // Sanity check on the harness itself, not the system under test.
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

  /** Signs in a fresh user and creates a master profile — still `pending_verification`. */
  async function signInAsMaster(): Promise<SignedInMaster> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    // 201 here, unlike the availability routes: creating a profile really does
    // create something.
    expect(res.status).toBe(201);
    return { ...caller, masterId: (res.body as { id: string }).id };
  }

  /**
   * Signs in a fresh master and pushes `verification_status` to `active`
   * with raw SQL — never through the admin endpoints, which are somebody
   * else's suite to own here.
   */
  async function signInAsActiveMaster(): Promise<SignedInMaster> {
    const master = await signInAsMaster();
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [
      master.masterId,
    ]);
    return master;
  }

  async function suspend(masterId: string): Promise<void> {
    await pool.query(
      `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
      [masterId],
    );
  }

  async function isAvailableColumn(masterId: string): Promise<boolean> {
    const result = await pool.query<{ is_available: boolean }>(
      'select is_available from masters where id = $1',
      [masterId],
    );
    return result.rows[0]?.is_available ?? false;
  }

  async function redisHasPresence(masterId: string): Promise<boolean> {
    const value = await redis.get(keyFor(masterId));
    return value !== null;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    // The schema's own floor: the smallest TTL/heartbeat pair that still
    // satisfies "TTL at least twice the heartbeat" — see the file header.
    originalTtl = process.env.PRESENCE_TTL_SECONDS;
    originalHeartbeat = process.env.PRESENCE_HEARTBEAT_SECONDS;
    process.env.PRESENCE_TTL_SECONDS = String(PRESENCE_TTL_SECONDS);
    process.env.PRESENCE_HEARTBEAT_SECONDS = String(PRESENCE_HEARTBEAT_SECONDS);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    redis = app.get(REDIS_CLIENT);
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
    if (originalTtl === undefined) {
      delete process.env.PRESENCE_TTL_SECONDS;
    } else {
      process.env.PRESENCE_TTL_SECONDS = originalTtl;
    }
    if (originalHeartbeat === undefined) {
      delete process.env.PRESENCE_HEARTBEAT_SECONDS;
    } else {
      process.env.PRESENCE_HEARTBEAT_SECONDS = originalHeartbeat;
    }
    await database.drop();
  });

  describe('authentication and role gating', () => {
    it('requires authentication on GET /masters/me/availability', async () => {
      const res = await get('/masters/me/availability');
      expect(res.status).toBe(401);
    });

    it('requires authentication on POST /masters/me/availability', async () => {
      const res = await post('/masters/me/availability').send({ isAvailable: true });
      expect(res.status).toBe(401);
    });

    it('requires authentication on POST /masters/me/availability/heartbeat', async () => {
      const res = await post('/masters/me/availability/heartbeat').send({});
      expect(res.status).toBe(401);
    });

    it(
      'answers with the role-gate status — not a 404 — for a signed-in caller who never ' +
        'created a master profile',
      async () => {
        // `RolesGuard` runs before `MasterAvailabilityService` ever looks for
        // a row: a caller holding no `master` role is refused "not yours to
        // do", the same 403 `GET /masters/me` answers for the identical
        // situation in `master-profile.e2e.test.ts`.
        const caller = await signIn();

        const res = await get('/masters/me/availability', caller.accessToken);

        expect(res.status).toBe(403);
        expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
      },
    );
  });

  describe('eligibility to go online', () => {
    it('refuses a pending_verification master with 409, naming the status, and writes no presence', async () => {
      const master = await signInAsMaster();

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details?.verificationStatus).toBe('pending_verification');
      expect(await redisHasPresence(master.masterId)).toBe(false);
    });

    it('refuses a suspended master with 409, naming the status, and writes no presence', async () => {
      const master = await signInAsActiveMaster();
      await suspend(master.masterId);

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details?.verificationStatus).toBe('suspended');
      expect(await redisHasPresence(master.masterId)).toBe(false);
    });
  });

  describe('going online and offline', () => {
    it('reports offline with no expiry before a master has ever gone online', async () => {
      const master = await signInAsActiveMaster();

      const res = await get('/masters/me/availability', master.accessToken);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        isAvailable: false,
        isLive: false,
        expiresInSeconds: null,
        heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS,
      });
    });

    it('going online returns the exact documented shape, live and bounded by the configured TTL', async () => {
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });

      // 200, not Nest's default 201 for a POST: the route carries an explicit
      // `@HttpCode(200)` because nothing is created. A toggle is a statement
      // of intent about a row that already exists.
      expect(res.status).toBe(200);
      const body = res.body as MasterAvailability;
      expect(Object.keys(body).sort()).toEqual(
        ['expiresInSeconds', 'heartbeatSeconds', 'isAvailable', 'isLive'].sort(),
      );
      expect(body).toEqual({
        isAvailable: true,
        isLive: true,
        expiresInSeconds: expect.any(Number),
        heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS,
      });
      expect(body.expiresInSeconds).toBeGreaterThan(0);
      expect(body.expiresInSeconds).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
      expect(await redisHasPresence(master.masterId)).toBe(true);
    });

    it('going online is idempotent: two consecutive calls both succeed and leave one live presence', async () => {
      const master = await signInAsActiveMaster();

      const first = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });
      const second = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((second.body as MasterAvailability).isAvailable).toBe(true);
      expect((second.body as MasterAvailability).isLive).toBe(true);
      expect(await redisHasPresence(master.masterId)).toBe(true);
    });

    it('going offline clears both the intent and the Redis key immediately, without waiting out the TTL', async () => {
      const master = await signInAsActiveMaster();
      await post('/masters/me/availability', master.accessToken).send({ isAvailable: true });
      expect(await redisHasPresence(master.masterId)).toBe(true);

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: false,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        isAvailable: false,
        isLive: false,
        expiresInSeconds: null,
        heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS,
      });
      expect(await redisHasPresence(master.masterId)).toBe(false);
    });
  });

  describe('presence divergence from stored intent — the headline behaviour', () => {
    it(
      'reports isAvailable true but isLive false, with expiresInSeconds null, once the presence ' +
        'key has expired without a heartbeat',
      async () => {
        // Deleting the Redis key directly rather than sleeping past the
        // configured TTL: it proves exactly the same divergence (a live
        // presence key gone while the stored intent is untouched) without
        // paying 30 real seconds of wall clock in every run of this suite.
        const master = await signInAsActiveMaster();
        await post('/masters/me/availability', master.accessToken).send({ isAvailable: true });
        expect(await redisHasPresence(master.masterId)).toBe(true);

        await redis.del(keyFor(master.masterId));

        const res = await get('/masters/me/availability', master.accessToken);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          isAvailable: true,
          isLive: false,
          expiresInSeconds: null,
          heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS,
        });
      },
    );

    it('a heartbeat refreshes the TTL back up after some of it has elapsed', async () => {
      const master = await signInAsActiveMaster();
      const online = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
      });
      const before = (online.body as MasterAvailability).expiresInSeconds as number;

      // Let a slice of the 30s TTL elapse so the refresh is observable —
      // small next to the suite's ~20s budget, and unavoidable: there is no
      // way to prove a heartbeat *extends* a TTL without letting time pass.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const heartbeat = await post('/masters/me/availability/heartbeat', master.accessToken).send(
        {},
      );
      const after = (heartbeat.body as MasterAvailability).expiresInSeconds as number;

      expect(heartbeat.status).toBe(200);
      expect(after).toBeGreaterThan(before - 2);
      expect(after).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    });
  });

  describe('POST /masters/me/availability/heartbeat', () => {
    it('answers 409 rather than a silent success when the master is not online', async () => {
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/availability/heartbeat', master.accessToken).send({});

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    });

    it(
      'drops a master suspended mid-shift: the heartbeat answers 409 naming "suspended", and ' +
        'afterwards the Redis key is gone and masters.is_available is false',
      async () => {
        const master = await signInAsActiveMaster();
        await post('/masters/me/availability', master.accessToken).send({ isAvailable: true });
        expect(await redisHasPresence(master.masterId)).toBe(true);

        await suspend(master.masterId);

        const res = await post('/masters/me/availability/heartbeat', master.accessToken).send({});

        expect(res.status).toBe(409);
        const body = res.body as ErrorEnvelope;
        expect(body.error.code).toBe('CONFLICT');
        expect(body.error.details?.verificationStatus).toBe('suspended');
        expect(await redisHasPresence(master.masterId)).toBe(false);
        expect(await isAvailableColumn(master.masterId)).toBe(false);
      },
    );
  });

  describe('validation — strict bodies', () => {
    it('rejects an unknown field on the toggle', async () => {
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: true,
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a toggle body with isAvailable missing', async () => {
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/availability', master.accessToken).send({});

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a non-boolean isAvailable', async () => {
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/availability', master.accessToken).send({
        isAvailable: 'yes',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects any field on the heartbeat body', async () => {
      const master = await signInAsActiveMaster();
      await post('/masters/me/availability', master.accessToken).send({ isAvailable: true });

      const res = await post('/masters/me/availability/heartbeat', master.accessToken).send({
        note: 'hello',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a soft-deleted profile', () => {
    it(
      'answers 404 on GET /masters/me/availability after DELETE /masters/me, and the delete ' +
        'itself already set is_available to false',
      async () => {
        const master = await signInAsActiveMaster();
        await post('/masters/me/availability', master.accessToken).send({ isAvailable: true });

        const deleted = await del('/masters/me', master.accessToken);
        expect(deleted.status).toBe(204);

        expect(await isAvailableColumn(master.masterId)).toBe(false);

        const res = await get('/masters/me/availability', master.accessToken);
        expect(res.status).toBe(404);
        expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      },
    );
  });
});
