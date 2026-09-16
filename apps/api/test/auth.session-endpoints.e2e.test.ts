import { randomBytes, randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { refreshTokens } from '../src/infra/database/schema/sessions';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import type { SessionSummary } from '../src/modules/auth/auth.types';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/auth/refresh`, `/auth/logout`, `/auth/logout-all` and `/auth/sessions`
 * over real HTTP, through the real `AppModule` graph — the same construction
 * as `auth.guards.e2e.test.ts`, and for the same reason.
 *
 * What only this layer can prove: that `refresh` is reachable without an
 * access token (a `@Public()` that regressed would break sign-in for every
 * client whose token has just expired — the one moment the endpoint exists
 * for), that a garbage token is a 401 rather than a 500, that every refusal is
 * the same bytes, and that logout actually stops the next request. None of
 * that is visible from the service: `SessionsService` cannot tell whether a
 * guard is in front of it.
 *
 * There is no sign-in endpoint to call — on the consumer path that is OTP
 * verification (issue #29, ADR-0008) — so sessions are opened through
 * `SessionsService`, which is what that endpoint will do.
 */

/** `users.phone_e164` is unique among live rows — see `auth.sessions.integration.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99453${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid refresh token that was never issued by anybody. */
function fabricateToken(id: string = randomUUID()): string {
  return `${id}.${randomBytes(32).toString('base64url')}`;
}

/**
 * The error envelope minus its `requestId` — fresh per request by design, and
 * therefore the only field that may legitimately differ between two responses
 * that must otherwise be indistinguishable.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

describe('session endpoints over HTTP (issue #26)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let db: Database;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let limiter: RateLimiterService;

  interface SignedIn {
    readonly userId: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly phoneE164: string;
  }

  async function signIn(roles: readonly UserRoleName[] = ['customer']): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
    return openSession(created.user.id, phoneE164);
  }

  /** Another device for an account that already exists. */
  async function openSession(userId: string, phoneE164 = ''): Promise<SignedIn> {
    const pair = await sessionsService.startSession({ userId });
    return {
      userId,
      sessionId: tokens.verifyAccessToken(pair.accessToken).sid,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      phoneE164,
    };
  }

  function postRefresh(refreshToken: unknown) {
    return request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  /**
   * Moves a spent token's `used_at` into the past, which is how a replay is
   * put outside the ten-second retry window without the suite sleeping for
   * ten seconds.
   *
   * The alternative — running the app with `REFRESH_REUSE_GRACE_SECONDS=0` —
   * would make every assertion here depend on a millisecond boundary, and
   * would test a configuration nobody deploys. Reaching into the row is the
   * same setup move `auth.guards.e2e.test.ts` makes when it revokes a session
   * directly.
   */
  async function backdateUse(refreshToken: string): Promise<void> {
    const parsed = tokens.parseRefreshToken(refreshToken);
    expect(parsed).not.toBeNull();
    await db
      .update(refreshTokens)
      .set({ usedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.id, parsed?.id as string));
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Point the real `ConfigModule` at the throwaway database rather than
    // overriding `DATABASE_CONNECTION`, so the wiring under test is the
    // application's own — see the same note in `auth.guards.e2e.test.ts`.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Load-bearing, not cosmetic: `Test.createTestingModule` installs
      // `TestingLogger`, whose `log`/`warn`/`debug` are empty bodies. The
      // logging assertions at the bottom of this file would pass against a
      // logger that discards every line they check, and would keep passing if
      // the code logged the refresh token itself.
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    db = app.get<Database>(DATABASE_CONNECTION);
    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    limiter = app.get(RateLimiterService);
  });

  afterEach(async () => {
    // `/auth/refresh` carries the real per-IP limit (120/hour by default) and
    // this suite is many requests from one address, so without this a second
    // run within the hour would start answering 429 and every failure would
    // look like a bug in the endpoint. Never FLUSHDB — the Redis is shared;
    // delete exactly the keys these requests created, in both loopback
    // spellings, since which one Fastify reports depends on how the OS
    // resolved the listen address.
    await Promise.all(
      ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map((ip) => limiter.reset('refresh', 'ip', ip)),
    );
  });

  afterAll(async () => {
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  describe('POST /auth/refresh', () => {
    it('is reachable with no access token at all, and returns a working new pair', async () => {
      // The whole point of the endpoint is that the caller's access token has
      // expired. Requiring one would make it useless exactly when it is
      // needed, so `@Public()` here is behaviour, not decoration.
      const caller = await signIn();

      const res = await postRefresh(caller.refreshToken);

      expect(res.status).toBe(200);
      const body = res.body as {
        accessToken: string;
        refreshToken: string;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
      };
      expect(body.refreshToken).not.toBe(caller.refreshToken);
      expect(Date.parse(body.accessTokenExpiresAt)).toBeGreaterThan(Date.now());

      // "Working" means the next request is authenticated by it — verifying
      // the signature here would only prove the endpoint can sign a string.
      const authenticated = await get('/auth/sessions', body.accessToken);
      expect(authenticated.status).toBe(200);
    });

    it('answers 422 for a body that is not a refresh request', async () => {
      // The Zod pipe, before the service sees anything: a missing field, a
      // wrong type, an unbounded string.
      const missing = await request(app.getHttpServer()).post('/auth/refresh').send({});
      const wrongType = await postRefresh(12345);
      const oversized = await postRefresh('x'.repeat(300));

      for (const res of [missing, wrongType, oversized]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('answers 401 — not 500 — for a well-shaped body carrying a garbage token', async () => {
      // `refresh_tokens.id` is a `uuid` column, so a token that reached the
      // database as "garbage" would raise 22P02 and surface as a 500. A
      // response a caller can tell apart from the others is the oracle the
      // design rules out, and a 500 is also an alert somebody gets paged for.
      for (const garbage of ['garbage', 'a.b', `${randomUUID()}.short`, '....']) {
        const res = await postRefresh(garbage);
        expect(res.status).toBe(401);
        expect((res.body as ErrorEnvelope).error.code).toBe('UNAUTHORIZED');
      }
    });

    it('answers every failure with byte-identical bytes, so the endpoint is not an oracle', async () => {
      // Four causes that the server logs differently and the client must not
      // be able to tell apart: a token that never existed, a real id with the
      // wrong secret, a replayed spent token (which also just revoked the
      // family), and a string that is not one of ours at all.
      const caller = await signIn();
      const parsed = tokens.parseRefreshToken(caller.refreshToken);
      expect(parsed).not.toBeNull();

      const rotated = await postRefresh(caller.refreshToken);
      expect(rotated.status).toBe(200);
      await backdateUse(caller.refreshToken);

      const unknownToken = await postRefresh(fabricateToken());
      const wrongSecret = await postRefresh(fabricateToken(parsed?.id));
      const reuseDetected = await postRefresh(caller.refreshToken);
      const malformed = await postRefresh('not-a-token');

      for (const res of [unknownToken, wrongSecret, reuseDetected, malformed]) {
        expect(res.status).toBe(401);
        expect(envelopeWithoutRequestId(res.body)).toEqual(
          envelopeWithoutRequestId(unknownToken.body),
        );
      }

      // The reason vocabulary belongs in the server log and nowhere else.
      const raw = [unknownToken, wrongSecret, reuseDetected, malformed]
        .map((res) => res.text)
        .join('\n');
      for (const reason of ['reuse_detected', 'bad_secret', 'unknown_token', 'malformed']) {
        expect(raw).not.toContain(reason);
      }

      // And the replay really did revoke the family, not merely answer 401.
      const afterReuse = await get('/auth/sessions', caller.accessToken);
      expect(afterReuse.status).toBe(401);
    });

    it('signs the user out of every device when a spent token is replayed', async () => {
      const first = await signIn();
      const second = await openSession(first.userId);

      const rotated = await postRefresh(first.refreshToken);
      expect(rotated.status).toBe(200);
      await backdateUse(first.refreshToken);

      expect((await postRefresh(first.refreshToken)).status).toBe(401);

      // The other device, which was never involved, is gone too — the wider
      // reading of the rule, which is the one issue #26 states.
      expect((await postRefresh(second.refreshToken)).status).toBe(401);
      expect((await get('/auth/sessions', second.accessToken)).status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('requires authentication', async () => {
      const res = await post('/auth/logout');

      expect(res.status).toBe(401);
    });

    it('answers 204 and leaves both halves of the session unusable', async () => {
      const caller = await signIn();
      expect((await get('/auth/sessions', caller.accessToken)).status).toBe(200);

      const res = await post('/auth/logout', caller.accessToken);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      // The refresh token cannot start the session up again...
      expect((await postRefresh(caller.refreshToken)).status).toBe(401);
      // ...and the access token minted before the logout is refused too, even
      // though it is still inside its fifteen minutes. That only works because
      // every request re-reads the session from the database.
      expect((await get('/auth/sessions', caller.accessToken)).status).toBe(401);
    });

    it('signs out only the device that asked', async () => {
      const caller = await signIn();
      const other = await openSession(caller.userId);

      expect((await post('/auth/logout', caller.accessToken)).status).toBe(204);

      expect((await get('/auth/sessions', other.accessToken)).status).toBe(200);
      expect((await postRefresh(other.refreshToken)).status).toBe(200);
    });
  });

  describe('POST /auth/logout-all', () => {
    it('requires authentication', async () => {
      const res = await post('/auth/logout-all');

      expect(res.status).toBe(401);
    });

    it('revokes every device, including the two that never asked', async () => {
      const first = await signIn();
      const second = await openSession(first.userId);
      const third = await openSession(first.userId);
      const bystander = await signIn();

      const res = await post('/auth/logout-all', first.accessToken);
      expect(res.status).toBe(204);

      for (const device of [first, second, third]) {
        expect((await postRefresh(device.refreshToken)).status).toBe(401);
        expect((await get('/auth/sessions', device.accessToken)).status).toBe(401);
      }

      // Scoped to the caller's own account, which is read from the resolved
      // actor — there is no user id in the request to get wrong.
      expect((await get('/auth/sessions', bystander.accessToken)).status).toBe(200);
    });
  });

  describe('GET /auth/sessions', () => {
    it('requires authentication', async () => {
      const res = await get('/auth/sessions');

      expect(res.status).toBe(401);
    });

    it('lists the caller’s live devices and marks exactly one as the current one', async () => {
      const caller = await signIn();
      const second = await openSession(caller.userId);
      const signedOut = await openSession(caller.userId);
      expect((await post('/auth/logout', signedOut.accessToken)).status).toBe(204);

      const res = await get('/auth/sessions', caller.accessToken);

      expect(res.status).toBe(200);
      const listed = res.body as SessionSummary[];
      expect(listed.map((row) => row.id).sort()).toEqual(
        [caller.sessionId, second.sessionId].sort(),
      );
      expect(listed.filter((row) => row.isCurrent)).toHaveLength(1);
      expect(listed.find((row) => row.isCurrent)?.id).toBe(caller.sessionId);
    });

    it('never shows another user’s device, and answers each caller about themselves only', async () => {
      const caller = await signIn();
      const stranger = await signIn();
      await openSession(stranger.userId);

      const mine = await get('/auth/sessions', caller.accessToken);
      const theirs = await get('/auth/sessions', stranger.accessToken);

      expect(mine.text).not.toContain(stranger.sessionId);
      expect(mine.text).not.toContain(stranger.userId);
      expect((theirs.body as SessionSummary[]).map((row) => row.id)).not.toContain(
        caller.sessionId,
      );
    });

    it('carries no token, no hash and no user id — a device list must not be a fingerprint endpoint', async () => {
      const caller = await signIn();
      const [tokenRow] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, tokens.parseRefreshToken(caller.refreshToken)?.id as string));
      expect(tokenRow?.tokenHash).toBeDefined();

      const res = await get('/auth/sessions', caller.accessToken);

      // Positive control first: the response does contain the session row, so
      // the absences below are absences from something rather than from an
      // empty body.
      expect(res.text).toContain(caller.sessionId);
      expect(res.text).not.toContain(caller.userId);
      expect(res.text).not.toContain(caller.refreshToken);
      expect(res.text).not.toContain(caller.accessToken);
      expect(res.text).not.toContain(tokenRow?.tokenHash as string);
      expect(res.text).not.toContain(caller.phoneE164);
    });
  });

  describe('no token value reaches a log line', () => {
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

    it('logs nothing of the credential across a full rotate, logout and replay cycle', async () => {
      // `docs/engineering/security.md`: never log tokens. The refresh path
      // logs twice on purpose — a debug line for a concurrent retry and a
      // warning naming the user on reuse — so this is the code most likely to
      // grow a "helpful" token in a template string.
      const caller = await signIn();
      const requestId = 'session-endpoints-rotate-cycle';

      const rotated = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('x-request-id', requestId)
        .send({ refreshToken: caller.refreshToken });
      expect(rotated.status).toBe(200);
      const issued = (rotated.body as { refreshToken: string }).refreshToken;

      await backdateUse(caller.refreshToken);
      const replayed = await postRefresh(caller.refreshToken);
      expect(replayed.status).toBe(401);

      const refused = await post('/auth/logout', caller.accessToken);
      expect(refused.status).toBe(401);

      const hashes = await db.select().from(refreshTokens);
      expect(hashes.length).toBeGreaterThan(0);

      const logged = sink.join('\n');
      // Positive control, and the operational requirement in its own right: a
      // reuse alert nobody can attribute to an account is a line nobody can
      // act on, and it is the only record that the detection fired.
      expect(logged).toContain('reuse detected');
      expect(logged).toContain(caller.userId);

      expect(logged).not.toContain(caller.refreshToken);
      expect(logged).not.toContain(issued);
      expect(logged).not.toContain(caller.accessToken);
      expect(logged).not.toContain(caller.phoneE164);
      for (const row of hashes) {
        expect(logged).not.toContain(row.tokenHash);
      }
      // Not even the public half of the token, which is what the rate limiter
      // buckets on — it names the credential a support engineer could then
      // look up.
      expect(logged).not.toContain(tokens.parseRefreshToken(caller.refreshToken)?.id as string);
    });
  });
});
