import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import { refreshTokens, sessions } from '../src/infra/database/schema/sessions';
import { users } from '../src/infra/database/schema/users';
import type { AuthConfig } from '../src/modules/auth/auth.config';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import { AccountNotActiveError, SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Same values `createAuthConfig` derives from the real 15m/30d defaults
 * (see `auth.config.test.ts`) — hand-built here because this file wires its
 * services by hand rather than going through Nest or `AppConfig`.
 */
const AUTH_CONFIG: AuthConfig = {
  accessSecret: 'integration-test-access-secret-0123456789ab',
  refreshSecret: 'integration-test-refresh-secret-zyxwvutsrqpo',
  accessTtlSeconds: 900,
  refreshTtlMs: 2_592_000_000,
  refreshReuseGraceMs: 10_000,
};

/**
 * `users.phone_e164` is partial-unique among live rows, so every test that
 * creates a user needs a phone number no other test in this file has used —
 * sharing one throwaway database across tests (rather than one per test, as
 * `database.migrations.test.ts` does) means each test's own seed must not
 * collide with another's (CLAUDE.md §13: "every test seeds and cleans its own
 * data").
 */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99450${String(phoneCounter).padStart(7, '0')}`;
}

describe('auth: users, roles, and device sessions against real Postgres', () => {
  let pool: Pool;
  let db: Database;
  let database: ThrowawayDatabase;
  let usersRepo: UsersRepository;
  let tokens: TokenService;
  let sessionsRepo: SessionsRepository;
  let sessionsService: SessionsService;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });

    usersRepo = new UsersRepository(db);
    tokens = new TokenService(AUTH_CONFIG);
    sessionsRepo = new SessionsRepository(db);
    sessionsService = new SessionsService(sessionsRepo, usersRepo, tokens, AUTH_CONFIG);
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('migrations create the users, user_roles, sessions and refresh_tokens tables', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'user_roles', 'sessions', 'refresh_tokens')
    `);

    expect(result.rows.map((row) => row.table_name).sort()).toEqual([
      'refresh_tokens',
      'sessions',
      'user_roles',
      'users',
    ]);
  });

  describe('users can hold more than one role', () => {
    it('creates a user with both customer and master roles and reads both back', async () => {
      const created = await usersRepo.create({
        phoneE164: nextPhone(),
        roles: ['customer', 'master'],
      });

      const found = await usersRepo.findByIdWithRoles(created.user.id);

      expect(found).toBeDefined();
      expect([...(found?.roles ?? [])].sort()).toEqual(['customer', 'master']);
    });
  });

  describe('the partial unique index on live phone numbers', () => {
    it('rejects a second live user with the same phone_e164', async () => {
      const phone = nextPhone();
      await usersRepo.create({ phoneE164: phone, roles: ['customer'] });

      await expect(usersRepo.create({ phoneE164: phone, roles: ['customer'] })).rejects.toThrow();
    });

    it('allows re-registering a phone number once the previous holder is soft-deleted', async () => {
      const phone = nextPhone();
      const first = await usersRepo.create({ phoneE164: phone, roles: ['customer'] });

      // No public API soft-deletes a user yet (out of scope for issue #25) —
      // this reaches into the table directly to set up the state the partial
      // index is meant to permit.
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, first.user.id));

      const second = await usersRepo.create({ phoneE164: phone, roles: ['master'] });

      expect(second.user.id).not.toBe(first.user.id);
      expect(second.user.phoneE164).toBe(phone);
    });

    it('findByIdWithRoles returns undefined for a soft-deleted user', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, created.user.id));

      await expect(usersRepo.findByIdWithRoles(created.user.id)).resolves.toBeUndefined();
    });
  });

  describe('SessionsService.startSession', () => {
    it('creates exactly one sessions row and one linked refresh_tokens row, with expires_at set from the refresh TTL', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      const now = new Date();

      await sessionsService.startSession({ userId: created.user.id }, now);

      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, created.user.id));
      expect(sessionRows).toHaveLength(1);
      const sessionRow = sessionRows[0];
      expect(sessionRow).toBeDefined();
      expect(sessionRow?.expiresAt.getTime()).toBe(now.getTime() + AUTH_CONFIG.refreshTtlMs);

      const tokenRows = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.sessionId, sessionRow?.id as string));
      expect(tokenRows).toHaveLength(1);
      expect(tokenRows[0]?.sessionId).toBe(sessionRow?.id);
    });

    it('never stores the refresh token, or its secret half, in plaintext anywhere on the row', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      const pair = await sessionsService.startSession({
        userId: created.user.id,
      });

      const parsed = tokens.parseRefreshToken(pair.refreshToken);
      expect(parsed).not.toBeNull();
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, parsed?.id as string));
      expect(row).toBeDefined();

      // Every column on the row, stringified, so a future column addition is
      // covered without this test needing to be told about it by name.
      const serialisedColumns = Object.values(row as Record<string, unknown>).map((value) =>
        String(value),
      );

      for (const column of serialisedColumns) {
        expect(column).not.toContain(pair.refreshToken);
        expect(column).not.toContain(parsed?.secret as string);
      }
    });

    it('issues an access token whose sid equals the id of the session row it created', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      const pair = await sessionsService.startSession({
        userId: created.user.id,
      });

      const [sessionRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, created.user.id));
      expect(sessionRow).toBeDefined();

      const claims = tokens.verifyAccessToken(pair.accessToken);
      expect(claims.sid).toBe(sessionRow?.id);
      expect(claims.sub).toBe(created.user.id);
    });

    it('derives roles from the database rather than from the caller — a user with two roles gets a token carrying both', async () => {
      // StartSessionInput has no `roles` field at all, so a caller cannot
      // pass one; this proves the positive half of that guarantee, that the
      // token nonetheless carries every role the account actually holds.
      const created = await usersRepo.create({
        phoneE164: nextPhone(),
        roles: ['customer', 'master'],
      });

      const pair = await sessionsService.startSession({ userId: created.user.id });
      const claims = tokens.verifyAccessToken(pair.accessToken);

      expect([...claims.roles].sort()).toEqual(['customer', 'master']);
    });
  });

  describe('SessionsService.startSession refuses an account that may not open a session (issue #25 fix)', () => {
    it('throws AccountNotActiveError, and opens no session, for a suspended user', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, created.user.id));

      await expect(sessionsService.startSession({ userId: created.user.id })).rejects.toThrow(
        AccountNotActiveError,
      );

      const sessionRows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, created.user.id));
      expect(sessionRows).toHaveLength(0);
    });

    it('throws AccountNotActiveError for a soft-deleted user', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, created.user.id));

      await expect(sessionsService.startSession({ userId: created.user.id })).rejects.toThrow(
        AccountNotActiveError,
      );
    });

    it('throws AccountNotActiveError for a user id that does not exist at all', async () => {
      await expect(sessionsService.startSession({ userId: randomUUID() })).rejects.toThrow(
        AccountNotActiveError,
      );
    });
  });

  describe('sessions.updated_at (issue #25 fix: $onUpdate)', () => {
    it('moves strictly forward on an UPDATE, proving the column is actually maintained rather than frozen at insert time', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      await sessionsService.startSession({ userId: created.user.id });

      const [sessionRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, created.user.id));
      expect(sessionRow).toBeDefined();

      // A bare .defaultNow() would leave updated_at permanently equal to
      // created_at; a short wait keeps the two timestamps from landing in the
      // same tick regardless of the database's clock resolution.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await db
        .update(sessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(sessions.id, sessionRow?.id as string));

      const [updated] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionRow?.id as string));
      expect(updated).toBeDefined();
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        sessionRow?.createdAt.getTime() as number,
      );
    });
  });

  describe('refresh token redemption is atomic under real concurrency (issue #26)', () => {
    it('lets exactly one of many concurrent redemptions of the same refresh token succeed', async () => {
      const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
      const pair = await sessionsService.startSession({ userId: created.user.id });
      const parsed = tokens.parseRefreshToken(pair.refreshToken);
      expect(parsed).not.toBeNull();
      const tokenId = parsed?.id as string;

      const CONCURRENCY = 8;
      // Separate pooled connections, one per contender — not `N` sequential
      // queries over the shared `db`/`pool` the rest of this file uses. The
      // property under test (`UPDATE ... WHERE id = $1 AND used_at IS NULL
      // RETURNING *`, the pattern `refresh_tokens` exists to make possible —
      // see the comment on that table in schema/sessions.ts) is what happens
      // when independent connections race the same conditional update at the
      // database, which one connection issuing queries one after another
      // cannot exercise: sequential calls never contend for the same row at
      // the same instant, so they would pass even if the update were not
      // atomic at all.
      const pools = Array.from(
        { length: CONCURRENCY },
        () => new Pool({ connectionString: database.url }),
      );
      try {
        const results = await Promise.all(
          pools.map((contender) =>
            contender.query(
              'UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING *',
              [tokenId],
            ),
          ),
        );

        const winners = results.filter((result) => result.rowCount === 1);
        expect(winners).toHaveLength(1);

        const losers = results.filter((result) => result.rowCount === 0);
        expect(losers).toHaveLength(CONCURRENCY - 1);
      } finally {
        await Promise.all(pools.map((contender) => contender.end()));
      }

      const [tokenRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, tokenId));
      expect(tokenRow?.usedAt).not.toBeNull();
    });
  });
});
