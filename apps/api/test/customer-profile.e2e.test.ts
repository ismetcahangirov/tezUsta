import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/customers` over real HTTP, through the real `AppModule` graph — the same
 * construction as `auth.session-endpoints.e2e.test.ts` and
 * `service-catalogue.e2e.test.ts`.
 *
 * What only this layer can prove: that every route actually sits behind
 * authentication (no accidental `@Public()`), that `POST /customers` is
 * idempotent and grants the `customer` role in the same transaction, that a
 * profile survives deletion as a revivable row rather than a hard delete, and
 * that `GET /customers/:id` cannot be used to probe whether a stranger's
 * account exists. None of that is visible from a unit test of the service in
 * isolation — a mocked repository cannot tell you whether the guard is wired,
 * and it cannot tell you whether two concurrent-looking HTTP calls actually
 * hit one row in Postgres.
 */

/** `users.phone_e164` is unique among live rows — see `auth.session-endpoints.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99454${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid but never-issued uuid — well-formed, guaranteed absent. */
function unknownUuid(): string {
  return randomUUID();
}

/**
 * The error envelope minus its `requestId` — fresh per request by design, and
 * therefore the only field that may legitimately differ between two responses
 * that must otherwise be indistinguishable. Copied from
 * `auth.session-endpoints.e2e.test.ts`.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

interface CustomerBody {
  readonly id: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

describe('customer profile endpoints over HTTP (issue #34)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
    readonly phoneE164: string;
  }

  async function signIn(roles: readonly UserRoleName[] = []): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    // Sanity check on the harness itself, not the system under test: a
    // malformed access token here would make every 401 assertion below
    // meaningless because the token was never going to authenticate anyway.
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return { userId: created.user.id, accessToken: pair.accessToken, phoneE164 };
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

  function patch(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).patch(path);
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

  async function rolesOf(userId: string): Promise<string[]> {
    const result = await pool.query<{ role: string }>(
      'select role from user_roles where user_id = $1 order by role',
      [userId],
    );
    return result.rows.map((row) => row.role);
  }

  async function customerRowCount(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from customers where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Point the real `ConfigModule` at the throwaway database rather than
    // overriding `DATABASE_CONNECTION`, so the wiring under test is the
    // application's own — see the same note in `auth.guards.e2e.test.ts` and
    // `auth.session-endpoints.e2e.test.ts`.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    pool = new Pool({ connectionString: database.url });
    // No `error` listener would mean a terminated backend — which is what
    // `ThrowawayDatabase.drop` does to a leaked session — surfaces as an
    // unhandled rejection and fails the whole run with a message naming no
    // test. Cheap insurance on a pool that only exists to inspect rows.
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
    await database.drop();
  });

  describe('POST /customers', () => {
    it('requires authentication', async () => {
      const res = await post('/customers');
      expect(res.status).toBe(401);
    });

    it('creates a profile, returns the wire shape, and grants the customer role', async () => {
      const caller = await signIn();

      const res = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });

      expect(res.status).toBe(201);
      const body = res.body as CustomerBody;
      expect(body.displayName).toBe('Anar');
      expect(body.avatarKey).toBeNull();
      expect(typeof body.id).toBe('string');
      expect(Date.parse(body.createdAt)).not.toBeNaN();
      expect(Date.parse(body.updatedAt)).not.toBeNaN();
      // No `userId`, no `deletedAt`, and nothing else — a profile response is
      // not a row dump.
      expect(Object.keys(body).sort()).toEqual([
        'avatarKey',
        'createdAt',
        'displayName',
        'id',
        'updatedAt',
      ]);

      // Sign-up on its own grants nothing (`roles: []` in `signIn`); this
      // endpoint is what turns an authenticated account into a customer, and
      // it has to do that in the same request that creates the profile row —
      // a caller who created a profile but holds no role could authenticate
      // as a customer everywhere and never actually be authorized as one.
      expect(await rolesOf(caller.userId)).toEqual(['customer']);
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signIn();

      const res = await post('/customers', caller.accessToken).send({
        displayName: 'Anar',
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a missing, empty, whitespace-only or oversized displayName', async () => {
      const caller = await signIn();

      const missing = await post('/customers', caller.accessToken).send({});
      const empty = await post('/customers', caller.accessToken).send({ displayName: '' });
      const whitespaceOnly = await post('/customers', caller.accessToken).send({
        displayName: '   ',
      });
      const oversized = await post('/customers', caller.accessToken).send({
        displayName: 'x'.repeat(81),
      });

      for (const res of [missing, empty, whitespaceOnly, oversized]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }

      // None of the rejected attempts left a row behind or granted a role —
      // a 422 must mean nothing happened, not "happened, then reported wrong".
      expect(await customerRowCount(caller.userId)).toBe(0);
      expect(await rolesOf(caller.userId)).toEqual([]);
    });

    it('is idempotent: a second call by the same user returns 200 and the same id, with no duplicate row', async () => {
      const caller = await signIn();

      const first = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      expect(first.status).toBe(201);
      const firstBody = first.body as CustomerBody;

      const second = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });

      expect(second.status).toBe(200);
      expect((second.body as CustomerBody).id).toBe(firstBody.id);
      expect(await customerRowCount(caller.userId)).toBe(1);
    });

    it('updates displayName on a repeat call with a different name, keeping the same id', async () => {
      const caller = await signIn();

      const first = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      const firstBody = first.body as CustomerBody;

      const second = await post('/customers', caller.accessToken).send({
        displayName: 'Anar Aliyev',
      });

      expect(second.status).toBe(200);
      const secondBody = second.body as CustomerBody;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.displayName).toBe('Anar Aliyev');
      expect(await customerRowCount(caller.userId)).toBe(1);
    });

    it('stays one profile when two requests for the same account arrive together', async () => {
      // The sequential idempotency test above passes even against a
      // read-then-insert implementation, because the first call has finished
      // writing before the second one reads. This is the case that does not:
      // both requests read "no profile" at the same moment, and an
      // implementation relying on that read either inserts twice or surfaces
      // the unique-index violation as a 500. A retried POST on a flaky mobile
      // connection is the ordinary way this arrives, not an exotic one.
      const caller = await signIn();

      const responses = await Promise.all([
        post('/customers', caller.accessToken).send({ displayName: 'Anar' }),
        post('/customers', caller.accessToken).send({ displayName: 'Anar' }),
      ]);

      for (const res of responses) {
        expect([200, 201]).toContain(res.status);
      }
      const ids = responses.map((res) => (res.body as CustomerBody).id);
      expect(ids[0]).toBe(ids[1]);
      expect(await customerRowCount(caller.userId)).toBe(1);
      expect(await rolesOf(caller.userId)).toEqual(['customer']);
    });

    it('does not duplicate a role or a profile row for a user who is already a master', async () => {
      // A plumber with a broken fridge is one account holding both roles
      // (`schema/users.ts`), not two — becoming a customer must add exactly
      // one role row and one customer row to the account that already exists.
      const caller = await signIn(['master']);
      expect(await rolesOf(caller.userId)).toEqual(['master']);

      const res = await post('/customers', caller.accessToken).send({ displayName: 'Usta Anar' });

      expect(res.status).toBe(201);
      expect(await rolesOf(caller.userId)).toEqual(['customer', 'master']);
      expect(await customerRowCount(caller.userId)).toBe(1);
    });
  });

  describe('GET /customers/me', () => {
    it('requires authentication', async () => {
      const res = await get('/customers/me');
      expect(res.status).toBe(401);
    });

    it("returns the caller's own profile", async () => {
      const caller = await signIn();
      const created = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      const createdBody = created.body as CustomerBody;

      const res = await get('/customers/me', caller.accessToken);

      expect(res.status).toBe(200);
      expect((res.body as CustomerBody).id).toBe(createdBody.id);
      expect((res.body as CustomerBody).displayName).toBe('Anar');
    });

    it('answers 404 for a caller with no profile', async () => {
      const caller = await signIn();

      const res = await get('/customers/me', caller.accessToken);

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });

    it('gives each of two different users only their own profile', async () => {
      const first = await signIn();
      const second = await signIn();
      await post('/customers', first.accessToken).send({ displayName: 'Birinci' });
      await post('/customers', second.accessToken).send({ displayName: 'Ikinci' });

      const firstRes = await get('/customers/me', first.accessToken);
      const secondRes = await get('/customers/me', second.accessToken);

      expect((firstRes.body as CustomerBody).displayName).toBe('Birinci');
      expect((secondRes.body as CustomerBody).displayName).toBe('Ikinci');
      expect((firstRes.body as CustomerBody).id).not.toBe((secondRes.body as CustomerBody).id);
    });
  });

  describe('PATCH /customers/me', () => {
    it('requires authentication', async () => {
      const res = await patch('/customers/me');
      expect(res.status).toBe(401);
    });

    it('rejects an empty body — at least one field is required', async () => {
      const caller = await signIn();
      await post('/customers', caller.accessToken).send({ displayName: 'Anar' });

      const res = await patch('/customers/me', caller.accessToken).send({});

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('updates displayName and returns the changed profile', async () => {
      const caller = await signIn();
      await post('/customers', caller.accessToken).send({ displayName: 'Anar' });

      const res = await patch('/customers/me', caller.accessToken).send({
        displayName: 'Anar Yeni',
      });

      expect(res.status).toBe(200);
      expect((res.body as CustomerBody).displayName).toBe('Anar Yeni');

      // Actually persisted, not merely echoed back.
      const reread = await get('/customers/me', caller.accessToken);
      expect((reread.body as CustomerBody).displayName).toBe('Anar Yeni');
    });

    it('answers 404 for a caller with no profile', async () => {
      const caller = await signIn();

      const res = await patch('/customers/me', caller.accessToken).send({ displayName: 'Anar' });

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });

    it('refuses to let the client set its own avatarKey', async () => {
      // `avatarKey` is written by the server once the presigned-upload flow
      // lands (it waits on the storage provider ADR-0005 leaves open), never
      // taken from the request body. A client that could set it to an
      // arbitrary string could point a customer's avatar at any storage key,
      // including one it does not own — which is exactly why the schema
      // refuses the field now, while refusing it costs nothing.
      const caller = await signIn();
      await post('/customers', caller.accessToken).send({ displayName: 'Anar' });

      const res = await patch('/customers/me', caller.accessToken).send({
        avatarKey: 'anything',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');

      // And the field the client tried to smuggle in did not slip through as
      // a side effect of validation still running.
      const reread = await get('/customers/me', caller.accessToken);
      expect((reread.body as CustomerBody).avatarKey).toBeNull();
    });
  });

  describe('GET /customers/:id', () => {
    it('requires authentication', async () => {
      const res = await get(`/customers/${unknownUuid()}`);
      expect(res.status).toBe(401);
    });

    it('returns the same body as GET /customers/me for the caller’s own id', async () => {
      const caller = await signIn();
      const created = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      const createdBody = created.body as CustomerBody;

      const byId = await get(`/customers/${createdBody.id}`, caller.accessToken);
      const byMe = await get('/customers/me', caller.accessToken);

      expect(byId.status).toBe(200);
      expect(byId.body).toEqual(byMe.body);
    });

    it('answers 422, not 500, for an id that is not a uuid', async () => {
      const caller = await signIn();

      const res = await get('/customers/not-a-uuid', caller.accessToken);

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it(
      'answers 404 — not 403 — for another user’s profile, with a body byte-identical to a ' +
        'genuinely unknown id',
      async () => {
        // The whole control: a 403 here would confirm the id belongs to
        // *someone*, turning
        // the endpoint into an oracle a stranger could walk sequential or
        // guessed ids against to enumerate real accounts. A 404 that differs
        // in any byte from the 404 for an id nobody ever used is the same
        // leak in a smaller disguise, which is why the comparison is on the
        // full envelope (minus the per-request `requestId`), not just the
        // status code.
        const owner = await signIn();
        const ownerProfile = await post('/customers', owner.accessToken).send({
          displayName: 'Sahib',
        });
        const ownerId = (ownerProfile.body as CustomerBody).id;

        const stranger = await signIn();

        const notYours = await get(`/customers/${ownerId}`, stranger.accessToken);
        const neverExisted = await get(`/customers/${unknownUuid()}`, stranger.accessToken);

        expect(notYours.status).toBe(404);
        expect(neverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(notYours.body)).toEqual(
          envelopeWithoutRequestId(neverExisted.body),
        );
      },
    );
  });

  describe('DELETE /customers/me', () => {
    it('requires authentication', async () => {
      const res = await del('/customers/me');
      expect(res.status).toBe(401);
    });

    it('answers 204 and makes the profile unreachable by both routes afterwards', async () => {
      const caller = await signIn();
      const created = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      const ownId = (created.body as CustomerBody).id;

      const res = await del('/customers/me', caller.accessToken);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      expect((await get('/customers/me', caller.accessToken)).status).toBe(404);
      expect((await get(`/customers/${ownId}`, caller.accessToken)).status).toBe(404);
    });

    it('answers 404 when the caller has no live profile to delete', async () => {
      const caller = await signIn();

      const first = await del('/customers/me', caller.accessToken);
      expect(first.status).toBe(404);

      // And calling it a second time, with nothing left alive, is the same
      // 404 again — not a 204 for "already gone".
      await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      await del('/customers/me', caller.accessToken);
      const second = await del('/customers/me', caller.accessToken);
      expect(second.status).toBe(404);
    });

    it('is revived, not recreated, by a POST after deletion — same id, one row', async () => {
      // The row is soft-deleted, not dropped (the same pattern `users.ts` uses
      // for accounts): a customer who deletes their profile and later signs
      // up again is the same customer, not a stranger who happens to hold the
      // same phone number. A hard delete followed by a fresh insert would
      // hand back a new id and would let a second `POST` slip past the
      // idempotency guarantee tested above by routing through the DELETE
      // first.
      const caller = await signIn();
      const created = await post('/customers', caller.accessToken).send({ displayName: 'Anar' });
      const originalId = (created.body as CustomerBody).id;

      expect((await del('/customers/me', caller.accessToken)).status).toBe(204);

      const revived = await post('/customers', caller.accessToken).send({
        displayName: 'Anar Yenidən',
      });

      expect(revived.status).toBe(200);
      const revivedBody = revived.body as CustomerBody;
      expect(revivedBody.id).toBe(originalId);
      expect(revivedBody.displayName).toBe('Anar Yenidən');
      expect(await customerRowCount(caller.userId)).toBe(1);

      // The revived profile is reachable normally again, not stuck behind the
      // 404 the deletion left in its place.
      expect((await get('/customers/me', caller.accessToken)).status).toBe(200);
    });
  });
});
