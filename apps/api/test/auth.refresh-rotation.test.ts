import { randomBytes, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import type { SessionRow } from '../src/infra/database/schema/sessions';
import { refreshTokens, sessions } from '../src/infra/database/schema/sessions';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { userRoles, users } from '../src/infra/database/schema/users';
import type { AuthConfig } from '../src/modules/auth/auth.config';
import type { TokenPair } from '../src/modules/auth/auth.types';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import type { RefreshFailureReason } from '../src/modules/auth/sessions.service';
import {
  AccountNotActiveError,
  InvalidRefreshTokenError,
  SessionsService,
} from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Refresh rotation, reuse detection and session revocation (issue #26),
 * against a real Postgres with the services wired by hand — the same shape as
 * `auth.sessions.integration.test.ts`, which this file continues.
 *
 * Nothing here is mocked below the service. Every claim under test is a claim
 * about what the *database* ends up holding — which token is spent, which
 * sessions carry `revoked_at`, and with which reason — and a repository double
 * would let all of it pass while the conditional `UPDATE` that makes
 * consumption atomic had been replaced by a read-then-write
 * (`schema/sessions.ts`, the comment on `refresh_tokens`).
 *
 * Time is passed in explicitly wherever the assertion depends on it. The grace
 * window is a clock comparison, so a test that let `refresh` default to
 * `new Date()` would be asserting against however long the previous query
 * happened to take.
 */

/**
 * Same values `createAuthConfig` derives from the real 15m/30d/10s defaults,
 * hand-built because this file goes through neither Nest nor `AppConfig`.
 */
const AUTH_CONFIG: AuthConfig = {
  accessSecret: 'rotation-test-access-secret-0123456789abcd',
  refreshSecret: 'rotation-test-refresh-secret-zyxwvutsrqponm',
  accessTtlSeconds: 900,
  refreshTtlMs: 2_592_000_000,
  refreshReuseGraceMs: 10_000,
};

/**
 * The same configuration with the retry window shut
 * (`REFRESH_REUSE_GRACE_SECONDS=0`, the documented lower bound in
 * `env.schema.ts`: "0 disables the retry path and makes a dropped response a
 * logout").
 *
 * A separate service instance rather than a mutated config, so a test that
 * wants the strict reading and one that wants the default cannot affect each
 * other by running in a particular order.
 */
const STRICT_CONFIG: AuthConfig = { ...AUTH_CONFIG, refreshReuseGraceMs: 0 };

/** `users.phone_e164` is unique among live rows — see `auth.sessions.integration.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99452${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid refresh token that was never issued by anybody. */
function fabricateToken(id: string = randomUUID()): string {
  return `${id}.${randomBytes(32).toString('base64url')}`;
}

describe('refresh rotation, reuse detection and revocation (issue #26)', () => {
  let pool: Pool;
  let db: Database;
  let database: ThrowawayDatabase;
  let usersRepo: UsersRepository;
  let tokens: TokenService;
  let sessionsRepo: SessionsRepository;
  let service: SessionsService;
  let strictService: SessionsService;

  interface SignedIn {
    readonly userId: string;
    readonly sessionId: string;
    readonly pair: TokenPair;
  }

  async function signIn(
    roles: readonly UserRoleName[] = ['customer'],
    now: Date = new Date(),
  ): Promise<SignedIn> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles });
    const pair = await service.startSession({ userId: created.user.id }, now);
    return {
      userId: created.user.id,
      sessionId: tokens.verifyAccessToken(pair.accessToken, now).sid,
      pair,
    };
  }

  /** Opens another device session for an account that already exists. */
  async function openAnotherSession(userId: string, now: Date = new Date()): Promise<SignedIn> {
    const pair = await service.startSession({ userId }, now);
    return { userId, sessionId: tokens.verifyAccessToken(pair.accessToken, now).sid, pair };
  }

  /**
   * The failure reason behind the single 401 every refresh failure answers
   * with.
   *
   * Every one of these is the same `InvalidRefreshTokenError` to a client, by
   * design — `reason` exists for the server log. This is the only layer at
   * which the distinction is observable, so it is the only layer that can
   * assert it.
   */
  async function reasonFor(
    target: SessionsService,
    token: string,
    now: Date = new Date(),
  ): Promise<RefreshFailureReason> {
    const error: unknown = await target.refresh(token, now).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InvalidRefreshTokenError);
    return (error as InvalidRefreshTokenError).reason;
  }

  async function readSession(id: string): Promise<SessionRow> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(row).toBeDefined();
    return row as SessionRow;
  }

  async function readSessionsOf(userId: string): Promise<readonly SessionRow[]> {
    return db.select().from(sessions).where(eq(sessions.userId, userId));
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Room for the eight-way concurrency case below plus the connections its
    // transactions hold: the default pool of 10 would make that test wait on
    // the pool rather than on the row lock it is about.
    pool = new Pool({ connectionString: database.url, max: 20 });
    db = drizzle(pool, { schema });

    usersRepo = new UsersRepository(db);
    tokens = new TokenService(AUTH_CONFIG);
    sessionsRepo = new SessionsRepository(db);
    service = new SessionsService(sessionsRepo, usersRepo, tokens, AUTH_CONFIG);
    strictService = new SessionsService(sessionsRepo, usersRepo, tokens, STRICT_CONFIG);
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('a refresh returns a new pair and spends the one presented', () => {
    it('returns a refresh token that is not the one presented, and an access token that verifies', async () => {
      const caller = await signIn();

      const rotated = await service.refresh(caller.pair.refreshToken);

      expect(rotated.refreshToken).not.toBe(caller.pair.refreshToken);
      const claims = tokens.verifyAccessToken(rotated.accessToken);
      expect(claims.sub).toBe(caller.userId);
      expect(claims.sid).toBe(caller.sessionId);
    });

    it('marks the presented token spent and leaves the new one unspent, so the family has exactly one live token', async () => {
      const caller = await signIn();
      const presented = tokens.parseRefreshToken(caller.pair.refreshToken);
      expect(presented).not.toBeNull();

      const rotated = await service.refresh(caller.pair.refreshToken);
      const issued = tokens.parseRefreshToken(rotated.refreshToken);
      expect(issued).not.toBeNull();

      const [spent] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, presented?.id as string));
      const [live] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, issued?.id as string));

      expect(spent?.usedAt).not.toBeNull();
      expect(live?.usedAt).toBeNull();
      // The spent row is kept rather than deleted — that is what makes a
      // replay land on a row that exists and therefore detectable at all.
      expect(spent?.sessionId).toBe(caller.sessionId);
      expect(live?.sessionId).toBe(caller.sessionId);
    });

    it('refuses a second use of the same token once the retry window has closed', async () => {
      // The single most load-bearing sentence in issue #26: "returns a new
      // refresh token and invalidates the presented one". With the window shut
      // there is no ambiguity left about what a second presentation means.
      const signedInAt = new Date();
      const caller = await signIn(['customer'], signedInAt);
      await strictService.refresh(caller.pair.refreshToken, signedInAt);

      // One millisecond later: outside a zero-length grace window by the
      // smallest amount a `Date` can express, and deterministic — a wall-clock
      // gap would be whatever the previous query took.
      const aMomentLater = new Date(signedInAt.getTime() + 1);

      await expect(
        strictService.refresh(caller.pair.refreshToken, aMomentLater),
      ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('chains: each new token rotates again, and the family keeps working', async () => {
      const caller = await signIn();

      let current = caller.pair.refreshToken;
      for (let i = 0; i < 3; i += 1) {
        const next = await service.refresh(current);
        expect(next.refreshToken).not.toBe(current);
        current = next.refreshToken;
      }

      expect((await readSession(caller.sessionId)).revokedAt).toBeNull();
    });
  });

  describe('replaying a spent token revokes every session the user holds', () => {
    it('reports reuse_detected and revokes all three of the user’s sessions, not only the replayed family', async () => {
      const signedInAt = new Date();
      const first = await signIn(['customer'], signedInAt);
      const second = await openAnotherSession(first.userId, signedInAt);
      const third = await openAnotherSession(first.userId, signedInAt);

      // Session A rotates once, legitimately, so its first token is spent.
      const rotated = await service.refresh(first.pair.refreshToken, signedInAt);

      // A minute later — comfortably outside the ten-second grace window, and
      // an explicit instant rather than a `setTimeout`, so the test neither
      // sleeps nor depends on how fast the database answered.
      const muchLater = new Date(signedInAt.getTime() + 60_000);

      await expect(reasonFor(service, first.pair.refreshToken, muchLater)).resolves.toBe(
        'reuse_detected',
      );

      const rows = await readSessionsOf(first.userId);
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.id).sort()).toEqual(
        [first.sessionId, second.sessionId, third.sessionId].sort(),
      );
      for (const row of rows) {
        expect(row.revokedAt).not.toBeNull();
        expect(row.revokedReason).toBe('reuse_detected');
      }

      // The point of revoking the family: the token the legitimate client is
      // holding — the one it got from its own successful rotation — dies too.
      // Without this the thief is locked out and the victim is not, which is
      // the wrong way round.
      await expect(reasonFor(service, rotated.refreshToken, muchLater)).resolves.toBe(
        'session_revoked',
      );
    });

    it('leaves another user’s sessions alone', async () => {
      const signedInAt = new Date();
      const victim = await signIn(['customer'], signedInAt);
      const bystander = await signIn(['customer'], signedInAt);
      await service.refresh(victim.pair.refreshToken, signedInAt);

      const muchLater = new Date(signedInAt.getTime() + 60_000);
      await expect(reasonFor(service, victim.pair.refreshToken, muchLater)).resolves.toBe(
        'reuse_detected',
      );

      expect((await readSession(bystander.sessionId)).revokedAt).toBeNull();
    });

    it('does not overwrite the reason on a session that was already revoked', async () => {
      // "Why was I signed out?" is answerable only if the FIRST reason
      // survives. A replay against a family already killed for reuse must not
      // rewrite that row, and a later ordinary logout must not either.
      const signedInAt = new Date();
      const caller = await signIn(['customer'], signedInAt);
      await service.refresh(caller.pair.refreshToken, signedInAt);

      const muchLater = new Date(signedInAt.getTime() + 60_000);
      await expect(reasonFor(service, caller.pair.refreshToken, muchLater)).resolves.toBe(
        'reuse_detected',
      );
      const afterReuse = await readSession(caller.sessionId);

      const laterStill = new Date(signedInAt.getTime() + 120_000);
      await expect(reasonFor(service, caller.pair.refreshToken, laterStill)).resolves.toBe(
        'session_revoked',
      );
      await service.logout(caller.sessionId, laterStill);

      const finalRow = await readSession(caller.sessionId);
      expect(finalRow.revokedReason).toBe('reuse_detected');
      expect(finalRow.revokedAt?.getTime()).toBe(afterReuse.revokedAt?.getTime());
    });

    it('revokes nothing when the token id is real but the secret is wrong', async () => {
      // The anti-DoS property, and the reason `bad_secret` is its own reason:
      // the id half travels in the clear, so anyone who has ever seen one
      // could otherwise sign a user out of every device at will by posting it
      // with 43 random characters after the dot.
      const caller = await signIn();
      const other = await openAnotherSession(caller.userId);
      const presented = tokens.parseRefreshToken(caller.pair.refreshToken);
      expect(presented).not.toBeNull();

      await expect(reasonFor(service, fabricateToken(presented?.id as string))).resolves.toBe(
        'bad_secret',
      );

      for (const row of await readSessionsOf(caller.userId)) {
        expect(row.revokedAt).toBeNull();
      }
      // And the real token still works afterwards, which is the user-visible
      // half of "revokes nothing".
      await expect(service.refresh(caller.pair.refreshToken)).resolves.toMatchObject({
        refreshToken: expect.any(String),
      });
      expect((await readSession(other.sessionId)).revokedAt).toBeNull();
    });

    it('revokes nothing for a token that was never issued at all', async () => {
      const caller = await signIn();

      await expect(reasonFor(service, fabricateToken())).resolves.toBe('unknown_token');

      expect((await readSession(caller.sessionId)).revokedAt).toBeNull();
    });
  });

  describe('the failure reasons the server log depends on', () => {
    it('reports malformed for a string that is not shaped like one of ours', async () => {
      // Shape is rejected before any query: `refresh_tokens.id` is a `uuid`
      // column, so a lookup on "not-a-token" would raise 22P02 and surface as
      // a 500 where the endpoint owes a 401.
      for (const rubbish of ['', 'not-a-token', 'a.b', `${randomUUID()}.short`, 'x'.repeat(200)]) {
        await expect(reasonFor(service, rubbish)).resolves.toBe('malformed');
      }
    });

    it('reports unknown_token for a well-formed token whose id names no row', async () => {
      await expect(reasonFor(service, fabricateToken())).resolves.toBe('unknown_token');
    });

    it('reports token_expired once the token row has passed its own expiry', async () => {
      const caller = await signIn();
      const presented = tokens.parseRefreshToken(caller.pair.refreshToken);
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.id, presented?.id as string));

      await expect(reasonFor(service, caller.pair.refreshToken)).resolves.toBe('token_expired');
    });

    it('reports session_expired when the family has passed its absolute end but the token row has not', async () => {
      // Only the session row is moved: at sign-in both expiries are equal, so
      // expiring the token too would stop at `token_expired` and this branch
      // would never be reached.
      const caller = await signIn();
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, caller.sessionId));

      await expect(reasonFor(service, caller.pair.refreshToken)).resolves.toBe('session_expired');
    });

    it('reports session_revoked after the device signed out', async () => {
      const caller = await signIn();
      await service.logout(caller.sessionId);

      await expect(reasonFor(service, caller.pair.refreshToken)).resolves.toBe('session_revoked');
    });

    it('does not spend the presented token when it refuses the request', async () => {
      // A refusal that consumed the token anyway would turn a revoked session
      // into a reuse alert the next time the client retried.
      const caller = await signIn();
      await service.logout(caller.sessionId);
      const presented = tokens.parseRefreshToken(caller.pair.refreshToken);

      await expect(reasonFor(service, caller.pair.refreshToken)).resolves.toBe('session_revoked');

      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, presented?.id as string));
      expect(row?.usedAt).toBeNull();
    });
  });

  describe('rotation never extends the family', () => {
    it('leaves sessions.expires_at exactly where sign-in put it after ten rotations', async () => {
      // Without this, a client refreshing every fifteen minutes holds a
      // session that never ends and "30-day refresh token" describes nothing.
      const signedInAt = new Date();
      const caller = await signIn(['customer'], signedInAt);
      const atSignIn = (await readSession(caller.sessionId)).expiresAt.getTime();
      expect(atSignIn).toBe(signedInAt.getTime() + AUTH_CONFIG.refreshTtlMs);

      let current = caller.pair.refreshToken;
      for (let i = 1; i <= 10; i += 1) {
        const next = await service.refresh(current, new Date(signedInAt.getTime() + i * 60_000));
        expect(next.refreshTokenExpiresAt.getTime()).toBe(atSignIn);
        current = next.refreshToken;
      }

      expect((await readSession(caller.sessionId)).expiresAt.getTime()).toBe(atSignIn);
    });

    it('issues each new token with the family’s expiry, not a fresh TTL of its own', async () => {
      const signedInAt = new Date();
      const caller = await signIn(['customer'], signedInAt);
      const rotatedAt = new Date(signedInAt.getTime() + 60_000);

      const rotated = await service.refresh(caller.pair.refreshToken, rotatedAt);
      const issued = tokens.parseRefreshToken(rotated.refreshToken);
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, issued?.id as string));

      expect(row?.expiresAt.getTime()).toBe(signedInAt.getTime() + AUTH_CONFIG.refreshTtlMs);
    });

    it('records the refresh on sessions.last_used_at, which is what the device list sorts by', async () => {
      const signedInAt = new Date();
      const caller = await signIn(['customer'], signedInAt);
      const before = (await readSession(caller.sessionId)).lastUsedAt.getTime();

      const refreshedAt = new Date(signedInAt.getTime() + 3_600_000);
      await service.refresh(caller.pair.refreshToken, refreshedAt);

      const after = (await readSession(caller.sessionId)).lastUsedAt;
      expect(after.getTime()).toBe(refreshedAt.getTime());
      expect(after.getTime()).toBeGreaterThan(before);
    });
  });

  describe('status and roles are re-read from the database on every refresh', () => {
    it('refuses a user suspended since sign-in, and leaves the session revoked for suspension', async () => {
      // The fifteen-minute access token is the *most* a suspension can be
      // delayed; the refresh path is where it becomes permanent, so a
      // suspended user must not be able to refresh even once more.
      const caller = await signIn();
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, caller.userId));

      await expect(service.refresh(caller.pair.refreshToken)).rejects.toBeInstanceOf(
        AccountNotActiveError,
      );

      const row = await readSession(caller.sessionId);
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe('suspension');
    });

    it('refuses a user soft-deleted since sign-in', async () => {
      const caller = await signIn();
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, caller.userId));

      await expect(service.refresh(caller.pair.refreshToken)).rejects.toBeInstanceOf(
        AccountNotActiveError,
      );
      expect((await readSession(caller.sessionId)).revokedReason).toBe('suspension');
    });

    it('carries a role granted since sign-in into the new access token', async () => {
      // The claim is a cache, not an authority: the old token says `customer`
      // for its whole 15-minute life, and a refresh is the point at which the
      // server gets to decide again.
      const caller = await signIn(['customer']);
      expect(tokens.verifyAccessToken(caller.pair.accessToken).roles).toEqual(['customer']);

      await db.insert(userRoles).values({ userId: caller.userId, role: 'master' });

      const rotated = await service.refresh(caller.pair.refreshToken);

      expect([...tokens.verifyAccessToken(rotated.accessToken).roles].sort()).toEqual([
        'customer',
        'master',
      ]);
      expect([...tokens.verifyAccessToken(caller.pair.accessToken).roles]).toEqual(['customer']);
    });
  });

  describe('logout and logout-all', () => {
    it('revokes only the device that asked, and records why', async () => {
      const caller = await signIn();
      const other = await openAnotherSession(caller.userId);

      await service.logout(caller.sessionId);

      expect((await readSession(caller.sessionId)).revokedReason).toBe('logout');
      expect((await readSession(other.sessionId)).revokedAt).toBeNull();
      await expect(service.refresh(other.pair.refreshToken)).resolves.toBeDefined();
    });

    it('is idempotent: signing out twice changes nothing', async () => {
      const caller = await signIn();
      await service.logout(caller.sessionId);
      const first = await readSession(caller.sessionId);

      await service.logout(caller.sessionId, new Date(Date.now() + 60_000));

      const second = await readSession(caller.sessionId);
      expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
      expect(second.revokedReason).toBe('logout');
    });

    it('signs every device out, the one that asked included, and reports how many', async () => {
      const caller = await signIn();
      const second = await openAnotherSession(caller.userId);
      const third = await openAnotherSession(caller.userId);

      await expect(service.logoutAll(caller.userId)).resolves.toBe(3);

      for (const id of [caller.sessionId, second.sessionId, third.sessionId]) {
        expect((await readSession(id)).revokedReason).toBe('logout_all');
      }
      await expect(reasonFor(service, second.pair.refreshToken)).resolves.toBe('session_revoked');
    });

    it('revokes every session for a suspension, with the reason an operator can find', async () => {
      // No endpoint calls this yet — admin actions are EPIC 13 — but the
      // behaviour is a property of the session model, and the reason on the
      // row is the whole audit trail.
      const caller = await signIn();
      await openAnotherSession(caller.userId);

      await expect(service.revokeAllForSuspension(caller.userId)).resolves.toBe(2);

      for (const row of await readSessionsOf(caller.userId)) {
        expect(row.revokedReason).toBe('suspension');
      }
    });
  });

  describe('the device list', () => {
    it('shows only live sessions, marks exactly one as current, and carries no token or user id', async () => {
      const caller = await signIn();
      const second = await openAnotherSession(caller.userId);
      const revoked = await openAnotherSession(caller.userId);
      await service.logout(revoked.sessionId);

      const listed = await service.listSessions(caller.userId, caller.sessionId);

      expect(listed.map((row) => row.id).sort()).toEqual(
        [caller.sessionId, second.sessionId].sort(),
      );
      expect(listed.filter((row) => row.isCurrent)).toHaveLength(1);
      expect(listed.find((row) => row.isCurrent)?.id).toBe(caller.sessionId);

      const serialised = JSON.stringify(listed);
      expect(serialised).not.toContain(caller.userId);
      expect(serialised).not.toContain(caller.pair.refreshToken);
    });

    it('hides a session that has passed its absolute expiry, so nobody is invited to sign out something already gone', async () => {
      const caller = await signIn();
      const stale = await openAnotherSession(caller.userId);
      await db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, stale.sessionId));

      const listed = await service.listSessions(caller.userId, caller.sessionId);

      expect(listed.map((row) => row.id)).toEqual([caller.sessionId]);
    });

    it('never shows another user’s session', async () => {
      const caller = await signIn();
      const stranger = await signIn();

      const listed = await service.listSessions(caller.userId, caller.sessionId);

      expect(listed.map((row) => row.id)).not.toContain(stranger.sessionId);
      expect(listed).toHaveLength(1);
    });
  });

  /**
   * The case issue #26 calls out by name: "a concurrent double-refresh from a
   * flaky network must not look like theft and lock out a legitimate user".
   *
   * These calls are genuinely simultaneous — `Promise.all` over a pool with a
   * connection each, so the contenders race the same row at the database.
   * Sequential calls would exercise nothing: they cannot interleave, so they
   * would pass identically against a read-then-write implementation, which is
   * the exact mistake that turns one dropped response into a sign-out on every
   * device the user owns.
   */
  describe('concurrent refreshes with the same token', () => {
    it('lets both succeed inside the grace window, revoking nothing', async () => {
      const caller = await signIn();

      const results = await Promise.all([
        service.refresh(caller.pair.refreshToken),
        service.refresh(caller.pair.refreshToken),
      ]);

      // Two live tokens in one family is the documented cost of the retry
      // path, and it is bounded: both die with the family, and the window is
      // seconds.
      expect(results[0].refreshToken).not.toBe(results[1].refreshToken);
      expect(results[0].refreshToken).not.toBe(caller.pair.refreshToken);
      expect(results[1].refreshToken).not.toBe(caller.pair.refreshToken);

      const row = await readSession(caller.sessionId);
      expect(row.revokedAt).toBeNull();
      expect(row.revokedReason).toBeNull();

      // And the session still works afterwards — the user is not signed out,
      // which is the whole point of the window.
      await expect(service.refresh(results[0].refreshToken)).resolves.toBeDefined();
    });

    it('lets eight simultaneous retries through without the family being revoked', async () => {
      // One flaky request retried a handful of times, not two. The grace
      // window is a time comparison, not a "second attempt" counter, so the
      // eighth arrival inside the window must be treated exactly like the
      // second.
      const caller = await signIn();

      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.refresh(caller.pair.refreshToken)),
      );

      expect(new Set(results.map((pair) => pair.refreshToken)).size).toBe(8);
      expect((await readSession(caller.sessionId)).revokedAt).toBeNull();
    });

    it('lets exactly one win when the grace window is shut', async () => {
      // `REFRESH_REUSE_GRACE_SECONDS=0` is documented in `env.schema.ts` as
      // "disables the retry path and makes a dropped response a logout", and
      // in `auth.config.ts` as "Zero makes a dropped response a sign-out", so
      // the loser of this race is a replay: one winner, one reuse alert, and
      // the family revoked.
      //
      // Both calls are handed the SAME instant, which is what two requests
      // arriving in the same millisecond actually produce — `refresh` defaults
      // `now` to `new Date()` at call time, and `Date` has millisecond
      // resolution. Passing it explicitly is what makes the outcome a property
      // of the code rather than of how long the previous query took: left to
      // the wall clock this case wins sometimes and loses sometimes, which
      // would be a flaky test rather than a test.
      const caller = await signIn();
      const simultaneously = new Date();

      const settled = await Promise.allSettled([
        strictService.refresh(caller.pair.refreshToken, simultaneously),
        strictService.refresh(caller.pair.refreshToken, simultaneously),
      ]);

      const fulfilled = settled.filter((result) => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const rejected = settled.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      const reason: unknown = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(InvalidRefreshTokenError);
      expect((reason as InvalidRefreshTokenError).reason).toBe('reuse_detected');

      expect((await readSession(caller.sessionId)).revokedReason).toBe('reuse_detected');
    });
  });
});
