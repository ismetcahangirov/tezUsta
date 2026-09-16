import { randomUUID } from 'node:crypto';

import { ConsoleLogger, Controller, Get, Module, Param } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { requireVisibleOrNotFound } from '../src/common/authorization/resource-visibility';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { sessions } from '../src/infra/database/schema/sessions';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { userRoles, users } from '../src/infra/database/schema/users';
import { ActorService } from '../src/modules/auth/actor.service';
import type { Actor } from '../src/modules/auth/auth.types';
import { CurrentActor } from '../src/modules/auth/current-actor.decorator';
import { Public } from '../src/modules/auth/public.decorator';
import { Roles } from '../src/modules/auth/roles.decorator';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { InvalidAccessTokenError, TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Issue #27's guards, end to end against a real Postgres, through the real
 * `AppModule` wiring — not a hand-assembled guard with a stubbed repository.
 *
 * That distinction is the point of the file. Every claim under test is a claim
 * about the *application*: that a route nobody decorated is protected, that the
 * roles enforced are the ones currently in `user_roles`, that "not yours" and
 * "does not exist" are the same bytes on the wire. A unit test with a fake
 * `ActorService` would assert the guard calls what it calls and would keep
 * passing after someone forgot the `APP_GUARD` registration, which is the
 * failure that actually matters.
 *
 * The routes below are registered into this test's own Nest module alongside
 * `AppModule`, the same way `health.e2e.test.ts` registers its throwing
 * controller. They never ship: there is no production controller yet for the
 * guards to protect (EPIC 4 onwards brings those), and inventing one in `src/`
 * purely to be a test target would be a real route with no reason to exist.
 */

const RESOURCE_SECRET = 'owner-only-payload-should-never-reach-a-stranger';
const AUTHENTICATED_THROW = 'boom-from-an-authenticated-route';

interface TestResource {
  readonly id: string;
  readonly ownerId: string;
  readonly secret: string;
}

/**
 * Stands in for a table an orders/masters module would query. In-memory because
 * what is under test is the *visibility decision*, not a query: the 404 must be
 * produced by `requireVisibleOrNotFound`, and a real table would let a `WHERE
 * owner_id = $1` accidentally produce the right answer for the wrong reason.
 */
const RESOURCES = new Map<string, TestResource>();

@Controller('__test-only/guards')
class GuardedController {
  /**
   * **Carries no decorator at all.** This is the secure-by-default assertion in
   * source form: nothing here opts in to protection, and the test below proves
   * it is protected anyway.
   */
  @Get('undecorated')
  undecorated(@CurrentActor() actor: Actor): { userId: string; roles: readonly UserRoleName[] } {
    return { userId: actor.userId, roles: actor.roles };
  }

  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }

  @Roles('master')
  @Get('master-only')
  masterOnly(): { ok: true } {
    return { ok: true };
  }

  @Get('resources/:id')
  resource(@CurrentActor() actor: Actor, @Param('id') id: string): TestResource {
    return requireVisibleOrNotFound(
      RESOURCES.get(id),
      (candidate) => candidate.ownerId === actor.userId,
    );
  }

  /** Authenticated, then fails — so the exception filter has an actor to log. */
  @Get('boom')
  boom(): never {
    throw new Error(AUTHENTICATED_THROW);
  }
}

@Module({ controllers: [GuardedController] })
class GuardedTestModule {}

/** A pending supertest request, before `await` turns it into a response. */
type PendingRequest = ReturnType<ReturnType<typeof request>['get']>;

/** `users.phone_e164` is unique among live rows — see `auth.sessions.integration.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

/**
 * The error envelope minus its `requestId`, which is fresh per request by
 * design and is therefore the one field that legitimately differs between two
 * responses that must otherwise be indistinguishable.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

describe('authentication, role and ownership guards (issue #27)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let db: Database;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;

  interface SignedIn {
    readonly userId: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly phoneE164: string;
  }

  async function signIn(roles: readonly UserRoleName[]): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const claims = tokens.verifyAccessToken(pair.accessToken);

    return {
      userId: created.user.id,
      sessionId: claims.sid,
      accessToken: pair.accessToken,
      phoneE164,
    };
  }

  function get(path: string, accessToken?: string): PendingRequest {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // The application reads its connection string from the environment through
    // `ConfigModule`, so pointing DATABASE_URL at the throwaway database is how
    // the *real* `AppModule` graph — guards, `ActorService`, repositories and
    // all — ends up talking to an isolated one. Overriding the
    // `DATABASE_CONNECTION` provider instead would swap out a piece of the
    // wiring this file exists to exercise.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, GuardedTestModule],
    })
      // NOT cosmetic, and not optional for this file. `Test.createTestingModule`
      // installs `TestingLogger` globally via `Logger.overrideLogger`, and that
      // class overrides `log`, `warn`, `debug` and `verbose` with empty bodies
      // — only `error` reaches a real sink. The guard records its rejection
      // reason at `warn` (a refused request is not a server fault), so the
      // assertions below would have been asserting against a logger that
      // discards the very line they exist to check, and would have passed
      // identically if the guard logged nothing at all. Restoring the real
      // `ConsoleLogger` is what makes this suite test the application's
      // logging rather than Nest's test harness.
      .setLogger(new ConsoleLogger())
      .compile();

    // Deliberately NOT re-registering the guards, filter or interceptor here:
    // AppModule provides them, and a test that registered its own would prove
    // nothing about the application that ships.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    db = app.get<Database>(DATABASE_CONNECTION);
    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    // Closes the pool via DatabaseModule's onModuleDestroy, without which DROP
    // DATABASE blocks behind this process's own open session.
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  describe('a route with no decorator defaults to protected', () => {
    it('answers 401 for a request carrying no credentials at all', async () => {
      const res = await get('/__test-only/guards/undecorated');

      expect(res.status).toBe(401);
    });

    it('answers 200 for the same route with a valid token, and reports the actor read from the database', async () => {
      const caller = await signIn(['customer']);

      const res = await get('/__test-only/guards/undecorated', caller.accessToken);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: caller.userId, roles: ['customer'] });
    });

    it('lets an explicitly @Public() route through with no credentials', async () => {
      const res = await get('/__test-only/guards/public');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('keeps the liveness and readiness probes public, so an unauthenticated orchestrator can still read them', async () => {
      const live = await request(app.getHttpServer()).get('/health/live');
      const ready = await request(app.getHttpServer()).get('/health/ready');

      expect(live.status).toBe(200);
      expect(ready.status).toBe(200);
    });
  });

  describe('401 is one indistinguishable answer for every authentication failure', () => {
    it('answers identically for no token, a malformed token, and an expired one', async () => {
      const caller = await signIn(['customer']);
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const expired = tokens.issueAccessToken(
        { userId: caller.userId, sessionId: caller.sessionId, roles: ['customer'] },
        anHourAgo,
      ).token;

      const none = await get('/__test-only/guards/undecorated');
      const malformed = await get('/__test-only/guards/undecorated', 'not-a-jwt-at-all');
      const stale = await get('/__test-only/guards/undecorated', expired);

      for (const res of [none, malformed, stale]) {
        expect(res.status).toBe(401);
        expect((res.body as ErrorEnvelope).error.code).toBe('UNAUTHORIZED');
      }

      // The security property, not merely "all three are 401": a client that
      // can tell "expired" from "bad signature" from "no header" holds an
      // oracle. Compared as whole envelopes so an added `details` field on one
      // path fails this test rather than slipping through.
      expect(envelopeWithoutRequestId(malformed.body)).toEqual(envelopeWithoutRequestId(none.body));
      expect(envelopeWithoutRequestId(stale.body)).toEqual(envelopeWithoutRequestId(none.body));
    });

    it('rejects an Authorization header that is not a single Bearer token', async () => {
      const caller = await signIn(['customer']);

      const wrongScheme = await request(app.getHttpServer())
        .get('/__test-only/guards/undecorated')
        .set('authorization', `Basic ${caller.accessToken}`);
      const bareToken = await request(app.getHttpServer())
        .get('/__test-only/guards/undecorated')
        .set('authorization', caller.accessToken);

      expect(wrongScheme.status).toBe(401);
      expect(bareToken.status).toBe(401);
    });

    it('accepts the scheme case-insensitively, as RFC 7235 requires', async () => {
      const caller = await signIn(['customer']);

      const res = await request(app.getHttpServer())
        .get('/__test-only/guards/undecorated')
        .set('authorization', `bearer ${caller.accessToken}`);

      expect(res.status).toBe(200);
    });

    it('leaks neither the token, the phone number, nor the failure reason into the response', async () => {
      const caller = await signIn(['customer']);
      const expired = tokens.issueAccessToken(
        { userId: caller.userId, sessionId: caller.sessionId, roles: ['customer'] },
        new Date(Date.now() - 60 * 60 * 1000),
      ).token;

      const res = await get('/__test-only/guards/undecorated', expired);
      const raw = JSON.stringify(res.body);

      expect(raw).not.toContain(expired);
      expect(raw).not.toContain(caller.phoneE164);
      // The reason vocabulary from `AccessTokenFailureReason`. It belongs in
      // the server log and nowhere else.
      for (const reason of ['expired', 'bad_signature', 'session_revoked', 'account_not_active']) {
        expect(raw).not.toContain(reason);
      }
    });
  });

  describe('the token claim is a cache, not an authority', () => {
    it('rejects a suspended user holding a token issued before the suspension', async () => {
      // The acceptance criterion in its exact order: sign in while active, so
      // the token genuinely predates the suspension, and only then suspend.
      const caller = await signIn(['customer']);
      const before = await get('/__test-only/guards/undecorated', caller.accessToken);
      expect(before.status).toBe(200);

      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, caller.userId));

      const after = await get('/__test-only/guards/undecorated', caller.accessToken);

      expect(after.status).toBe(401);
      // Same answer as an anonymous request, so the holder of a stolen token
      // learns nothing about the account's state.
      const anonymous = await get('/__test-only/guards/undecorated');
      expect(envelopeWithoutRequestId(after.body)).toEqual(
        envelopeWithoutRequestId(anonymous.body),
      );
    });

    it('rejects a soft-deleted user holding a token issued before the deletion', async () => {
      const caller = await signIn(['customer']);
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, caller.userId));

      const res = await get('/__test-only/guards/undecorated', caller.accessToken);

      expect(res.status).toBe(401);
    });

    it('enforces the roles currently in user_roles, not the ones the token was minted with', async () => {
      // Signed in holding both grants, so the token's `roles` claim says
      // `master` for its whole 15-minute life. Withdrawing the grant must take
      // effect on the very next request regardless.
      const caller = await signIn(['customer', 'master']);
      const before = await get('/__test-only/guards/master-only', caller.accessToken);
      expect(before.status).toBe(200);

      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, caller.userId), eq(userRoles.role, 'master')));

      const after = await get('/__test-only/guards/master-only', caller.accessToken);

      expect(after.status).toBe(403);
    });
  });

  /**
   * The rejection reasons themselves, read off `ActorService` directly.
   *
   * Every one of these produces the same 401 over HTTP — by design — so the
   * tests above cannot tell them apart, and neither can a client. An operator
   * has to: "why was I signed out?" is answerable only if the log line says
   * `session_revoked` rather than `account_not_active`. This is the only place
   * that distinction is observable, so it is the only place it can be asserted.
   */
  describe('the reason vocabulary the server log depends on', () => {
    async function reasonFor(userId: string, sessionId: string): Promise<string> {
      const actors = app.get(ActorService);
      const claims = tokens.verifyAccessToken(
        tokens.issueAccessToken({ userId, sessionId, roles: ['customer'] }).token,
      );

      const error = await actors.resolve(claims).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(InvalidAccessTokenError);
      return (error as InvalidAccessTokenError).reason;
    }

    it('reports unknown_session for a sid naming no session row', async () => {
      const caller = await signIn(['customer']);

      await expect(reasonFor(caller.userId, randomUUID())).resolves.toBe('unknown_session');
    });

    it('reports session_user_mismatch when a session is pointed at a different user', async () => {
      // The forged-claims case: a stolen or guessed session id aimed at another
      // — possibly more privileged — account.
      const owner = await signIn(['customer']);
      const other = await signIn(['customer']);

      await expect(reasonFor(other.userId, owner.sessionId)).resolves.toBe('session_user_mismatch');
    });

    it('reports session_revoked after a sign-out', async () => {
      const caller = await signIn(['customer']);
      await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(eq(sessions.id, caller.sessionId));

      await expect(reasonFor(caller.userId, caller.sessionId)).resolves.toBe('session_revoked');
    });

    it('reports session_expired once the family has passed its absolute expiry', async () => {
      const caller = await signIn(['customer']);
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, caller.sessionId));

      await expect(reasonFor(caller.userId, caller.sessionId)).resolves.toBe('session_expired');
    });

    it('reports unknown_user for a soft-deleted account, which reads as absent rather than deleted', async () => {
      const caller = await signIn(['customer']);
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, caller.userId));

      await expect(reasonFor(caller.userId, caller.sessionId)).resolves.toBe('unknown_user');
    });

    it('reports account_not_active for a suspended account', async () => {
      const caller = await signIn(['customer']);
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, caller.userId));

      await expect(reasonFor(caller.userId, caller.sessionId)).resolves.toBe('account_not_active');
    });

    it('returns the roles from user_roles rather than the ones in the claims it was handed', async () => {
      // `reasonFor` above mints claims saying `roles: ['customer']` regardless
      // of the account; here the account holds `master` only, and the resolved
      // actor must say so.
      const caller = await signIn(['master']);
      const actors = app.get(ActorService);
      const claims = tokens.verifyAccessToken(
        tokens.issueAccessToken({
          userId: caller.userId,
          sessionId: caller.sessionId,
          roles: ['customer'],
        }).token,
      );

      const actor = await actors.resolve(claims);

      expect(actor.roles).toEqual(['master']);
      expect(actor.userId).toBe(caller.userId);
      expect(actor.status).toBe('active');
    });
  });

  describe('a session that is no longer usable', () => {
    it('rejects a token whose session has been revoked', async () => {
      const caller = await signIn(['customer']);

      await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(eq(sessions.id, caller.sessionId));

      const res = await get('/__test-only/guards/undecorated', caller.accessToken);

      expect(res.status).toBe(401);
    });

    it('rejects a token whose session has passed its absolute expiry', async () => {
      const caller = await signIn(['customer']);

      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, caller.sessionId));

      const res = await get('/__test-only/guards/undecorated', caller.accessToken);

      expect(res.status).toBe(401);
    });
  });

  describe('role guard', () => {
    it('answers 403 when the caller holds none of the required roles', async () => {
      const customer = await signIn(['customer']);

      const res = await get('/__test-only/guards/master-only', customer.accessToken);

      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it('answers 200 when the caller holds the required role', async () => {
      const master = await signIn(['master']);

      const res = await get('/__test-only/guards/master-only', master.accessToken);

      expect(res.status).toBe(200);
    });

    it('answers 200 for a caller holding the required role among several', async () => {
      const both = await signIn(['customer', 'master']);

      const res = await get('/__test-only/guards/master-only', both.accessToken);

      expect(res.status).toBe(200);
    });

    it('answers 401, not 403, for an unauthenticated request to a role-restricted route', async () => {
      // Authentication is decided before role, so an anonymous caller never
      // learns that the route is master-only.
      const res = await get('/__test-only/guards/master-only');

      expect(res.status).toBe(401);
    });

    it('names no role in the 403 body', async () => {
      const customer = await signIn(['customer']);

      const res = await get('/__test-only/guards/master-only', customer.accessToken);

      expect(JSON.stringify(res.body)).not.toContain('master');
    });
  });

  describe("ownership: another user's resource is 404, indistinguishable from one that does not exist", () => {
    let owner: SignedIn;
    let stranger: SignedIn;

    beforeAll(async () => {
      owner = await signIn(['customer']);
      stranger = await signIn(['customer']);
      RESOURCES.set('resource-owned-by-owner', {
        id: 'resource-owned-by-owner',
        ownerId: owner.userId,
        secret: RESOURCE_SECRET,
      });
    });

    it('lets the owner read their own resource', async () => {
      const res = await get(
        '/__test-only/guards/resources/resource-owned-by-owner',
        owner.accessToken,
      );

      expect(res.status).toBe(200);
      expect((res.body as TestResource).secret).toBe(RESOURCE_SECRET);
    });

    it('answers 404 — not 403 — for an authenticated stranger, with a body byte-identical to a genuinely missing resource', async () => {
      const notYours = await get(
        '/__test-only/guards/resources/resource-owned-by-owner',
        stranger.accessToken,
      );
      const neverExisted = await get(
        '/__test-only/guards/resources/no-such-resource-id',
        stranger.accessToken,
      );

      expect(notYours.status).toBe(404);
      expect(neverExisted.status).toBe(404);

      // The whole control: a 403 here, or any difference between these two
      // envelopes, turns the endpoint into an existence oracle an attacker
      // walks ids against.
      expect(envelopeWithoutRequestId(notYours.body)).toEqual(
        envelopeWithoutRequestId(neverExisted.body),
      );
    });

    it('returns nothing about the resource it refused to show', async () => {
      const res = await get(
        '/__test-only/guards/resources/resource-owned-by-owner',
        stranger.accessToken,
      );
      const raw = JSON.stringify(res.body);

      expect(raw).not.toContain(RESOURCE_SECRET);
      expect(raw).not.toContain(owner.userId);
      expect(raw).not.toContain('resource-owned-by-owner');
    });
  });

  describe('the actor id and the rejection reason reach the server log, and only the log', () => {
    let sink: string[];
    let spies: MockInstance[];

    beforeEach(() => {
      sink = [];
      spies = spyOnEveryLogSink(sink);
    });

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    });

    it('logs the rejection reason beside the request id, while the response still carries the uniform 401', async () => {
      const caller = await signIn(['customer']);
      await db
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(eq(sessions.id, caller.sessionId));
      const requestId = 'guards-test-revoked-session';

      const res = await request(app.getHttpServer())
        .get('/__test-only/guards/undecorated')
        .set('authorization', `Bearer ${caller.accessToken}`)
        .set('x-request-id', requestId);

      expect(res.status).toBe(401);

      const logged = sink.join('\n');
      // Positive control and assertion in one: if the harness captured nothing
      // the first expectation fails, so the "not logged" ones below cannot pass
      // vacuously.
      expect(logged).toContain(requestId);
      expect(logged).toContain('session_revoked');
      expect(logged).not.toContain(caller.accessToken);
      expect(logged).not.toContain(caller.phoneE164);
      expect(JSON.stringify(res.body)).not.toContain('session_revoked');
    });

    it('ties a failure on an authenticated route to the actor id in the log, without putting it in the response', async () => {
      const caller = await signIn(['customer']);
      const requestId = 'guards-test-authenticated-boom';

      const res = await request(app.getHttpServer())
        .get('/__test-only/guards/boom')
        .set('authorization', `Bearer ${caller.accessToken}`)
        .set('x-request-id', requestId);

      expect(res.status).toBe(500);

      const logged = sink.join('\n');
      expect(logged).toContain(`[${requestId} actor=${caller.userId}]`);
      expect(logged).not.toContain(caller.accessToken);
      expect(logged).not.toContain(caller.phoneE164);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(caller.userId);
      expect(raw).not.toContain(AUTHENTICATED_THROW);
    });

    it('answers a guard-rejected request with the x-request-id header, even though the interceptor never runs', async () => {
      // Guards run before interceptors and short-circuit the pipeline, so this
      // header exists only because the guard resolves the id itself. Without
      // it every 401 in the system would be uncorrelatable with its log line.
      const res = await get('/__test-only/guards/undecorated');

      const header = res.headers['x-request-id'];
      expect(typeof header).toBe('string');
      expect((res.body as ErrorEnvelope).error.requestId).toBe(header);
    });
  });
});
