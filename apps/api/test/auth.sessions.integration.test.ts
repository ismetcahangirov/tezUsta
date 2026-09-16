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
import { SessionsService } from '../src/modules/auth/sessions.service';
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
    sessionsService = new SessionsService(sessionsRepo, tokens, AUTH_CONFIG);
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

      await sessionsService.startSession({ userId: created.user.id, roles: ['customer'] }, now);

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
        roles: ['customer'],
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
        roles: ['customer'],
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
  });
});
