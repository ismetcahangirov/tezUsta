import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import type { AuthConfig } from '../src/modules/auth/auth.config';
import { SessionsRepository } from '../src/modules/auth/sessions.repository';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

const AUTH_CONFIG: AuthConfig = {
  accessSecret: 'token-logging-test-access-secret-0123456789',
  refreshSecret: 'token-logging-test-refresh-secret-zyxwvutsrq',
  accessTtlSeconds: 900,
  refreshTtlMs: 2_592_000_000,
};

/**
 * Every place Nest's own `ConsoleLogger` (`@nestjs/common`) actually writes,
 * per the shipped source (`console-logger.service.js`): `console.log`,
 * `console.error`, and — for a printed stack trace — `process.stderr.write`
 * directly, bypassing `console.error` entirely. `console.warn`/`debug`/`info`
 * are included too, since a future call site could reasonably use any of
 * them, and this suite exists to keep that promise, not just today's call
 * sites.
 */
function spyOnEveryLogSink(sink: string[]): MockInstance[] {
  const record = (...parts: unknown[]): void => {
    sink.push(parts.map((part) => String(part)).join(' '));
  };

  return [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
  ];
}

describe('no token value ever appears in logs (issue #25)', () => {
  let pool: Pool;
  let db: Database;
  let database: ThrowawayDatabase;
  let sessionsService: SessionsService;
  let tokens: TokenService;

  let sink: string[];
  let spies: MockInstance[];

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });

    tokens = new TokenService(AUTH_CONFIG);
    sessionsService = new SessionsService(new SessionsRepository(db), tokens, AUTH_CONFIG);
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  beforeEach(() => {
    sink = [];
    spies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('positive control: the spy harness actually captures a Nest Logger call, proving a real leak would be caught', () => {
    // Guards against the failure mode where this whole suite passes only
    // because nothing was captured — see the file-level note below.
    new Logger('token-logging.test').log('canary-message-should-be-captured');

    expect(sink.some((entry) => entry.includes('canary-message-should-be-captured'))).toBe(true);
  });

  it('logs nothing containing the access token, refresh token, or refresh secret across a full startSession call and a deliberately failing verifyAccessToken', async () => {
    const usersRepo = new UsersRepository(db);
    const created = await usersRepo.create({
      phoneE164: '+994501111111',
      roles: ['customer'],
    });

    const pair = await sessionsService.startSession({
      userId: created.user.id,
      roles: ['customer'],
    });
    const parsed = tokens.parseRefreshToken(pair.refreshToken);
    expect(parsed).not.toBeNull();

    // Deliberately failing verification: a tampered access token, exercising
    // the same code path a stolen/forged token would hit in production.
    const tamperedToken = `${pair.accessToken.slice(0, -1)}${pair.accessToken.endsWith('a') ? 'b' : 'a'}`;
    try {
      tokens.verifyAccessToken(tamperedToken);
    } catch {
      // Expected — InvalidAccessTokenError. The point of this test is what
      // was logged on the way there, not the throw itself.
    }

    // As of this issue, nothing on this path calls `Logger`, `console`, or
    // writes to stdout/stderr at all — `sink` is expected to be empty. This
    // assertion is intentionally about *content*, not silence: if a future
    // change adds logging here (a very reasonable thing to want, e.g. an
    // audit line for session creation), this must still hold, whereas
    // asserting `sink` stays empty would immediately — and wrongly — fail the
    // build the day that logging is added.
    const combined = sink.join('\n');
    expect(combined).not.toContain(pair.accessToken);
    expect(combined).not.toContain(pair.refreshToken);
    expect(combined).not.toContain(parsed?.secret as string);
    expect(combined).not.toContain(tamperedToken);
  });
});
