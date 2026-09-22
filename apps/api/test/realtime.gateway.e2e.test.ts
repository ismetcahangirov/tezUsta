import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { sessions } from '../src/infra/database/schema/sessions';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { userRoles, users } from '../src/infra/database/schema/users';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import type { RealtimeSocketData } from '../src/modules/realtime/realtime.types';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The socket's front door (issue #166).
 *
 * Every assertion here is about the *upgrade*, not about anything the socket
 * later carries: rooms, events and positions are #167–#169. The question this
 * file answers is the one where a mistake is a security hole rather than a
 * missing feature — who is allowed to hold a connection at all.
 *
 * It runs against the real `AppModule` graph and a real Postgres, for the
 * reason `auth.guards.e2e.test.ts` states: a hand-assembled gateway with a
 * stubbed `ActorService` would keep passing after someone forgot to install
 * the authentication middleware, which is the failure that actually matters.
 *
 * **This suite calls `app.listen()`**, which no other suite does. Nest attaches
 * the socket.io server to the HTTP server, and an application that was only
 * `init()`ed has never bound a port for a client to dial.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99450${String(1_000_000 + phoneCounter).slice(-7)}`;
}

/** The one message every refusal carries. See `socket.authenticator.ts`. */
const UNAUTHORIZED = 'unauthorized';

describe('realtime gateway: who may hold a connection (issue #166)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let db: Database;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let url: string;

  /** Every socket this suite opened, closed in `afterEach` whatever happens. */
  const opened: Socket[] = [];

  interface SignedIn {
    readonly userId: string;
    readonly sessionId: string;
    readonly accessToken: string;
  }

  async function signIn(roles: readonly UserRoleName[] = ['customer']): Promise<SignedIn> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const claims = tokens.verifyAccessToken(pair.accessToken);

    return { userId: created.user.id, sessionId: claims.sid, accessToken: pair.accessToken };
  }

  /**
   * Dials the gateway and resolves with what happened, rather than throwing:
   * both outcomes are results this suite asserts on, and a rejected promise
   * would make "refused" the harder of the two to read.
   *
   * `reconnection: false` matters. A client left to retry keeps timers alive
   * past `app.close()` and turns a clean shutdown into a hanging test process
   * — the failure looks like a server leak and is not one.
   */
  function dial(options: {
    readonly token?: string | undefined;
    readonly query?: Record<string, string> | undefined;
  }): Promise<{ connected: boolean; error?: string; socket: Socket }> {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      ...(options.token === undefined ? {} : { auth: { token: options.token } }),
      ...(options.query === undefined ? {} : { query: options.query }),
    });
    opened.push(socket);

    return new Promise((resolve) => {
      socket.on('connect', () => {
        resolve({ connected: true, socket });
      });
      socket.on('connect_error', (error: Error) => {
        resolve({ connected: false, error: error.message, socket });
      });
    });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // As in `auth.guards.e2e.test.ts`: Nest's `TestingLogger` swallows
      // `warn`, and the refusal reason is recorded at `warn`.
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The adapter `main.ts` installs. Without this line every assertion below
    // would run against the in-memory adapter — a combination that never
    // ships — and the handshake-scrubbing test in particular would be
    // asserting about a serialisation path that was not in use.
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));

    // Port 0: the OS picks a free one, so two suites running in parallel
    // cannot collide on a hard-coded number.
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    db = app.get<Database>(DATABASE_CONNECTION);
    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
  });

  afterEach(() => {
    while (opened.length > 0) {
      opened.pop()?.disconnect();
    }
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

  describe('a connection is refused unless it proves who it is', () => {
    it('refuses a client that offers no token at all', async () => {
      const result = await dial({});

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('refuses a malformed token', async () => {
      const result = await dial({ token: 'not-a-jwt' });

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('refuses a token signed with the wrong secret', async () => {
      const caller = await signIn();
      const forged = new TokenService({
        accessSecret: 'a-secret-that-is-long-enough-to-sign-with-but-is-not-ours',
        refreshSecret: 'another-secret-that-is-long-enough-but-is-not-ours-either',
        accessTtlSeconds: 900,
        refreshTtlMs: 86_400_000,
        refreshReuseGraceMs: 10_000,
      }).issueAccessToken({
        userId: caller.userId,
        sessionId: caller.sessionId,
        roles: ['customer'],
      }).token;

      const result = await dial({ token: forged });

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('refuses a token whose session has been revoked', async () => {
      const caller = await signIn();
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, caller.sessionId));

      const result = await dial({ token: caller.accessToken });

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('refuses a token whose account is no longer active', async () => {
      const caller = await signIn();
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, caller.userId));

      const result = await dial({ token: caller.accessToken });

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('does not accept a token smuggled in the query string', async () => {
      const caller = await signIn();

      const result = await dial({ query: { token: caller.accessToken } });

      expect(result.connected).toBe(false);
      expect(result.error).toBe(UNAUTHORIZED);
    });

    it('tells a refused client nothing about which check failed', async () => {
      const caller = await signIn();
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, caller.sessionId));

      const revoked = await dial({ token: caller.accessToken });
      const absent = await dial({});
      const malformed = await dial({ token: 'not-a-jwt' });

      // Three different causes, one string. A client that could tell them
      // apart would hold an oracle over other people's accounts (issue #27).
      expect(new Set([revoked.error, absent.error, malformed.error])).toEqual(
        new Set([UNAUTHORIZED]),
      );
    });

    it('accepts a client holding a valid access token', async () => {
      const caller = await signIn();

      const result = await dial({ token: caller.accessToken });

      expect(result.connected).toBe(true);
      expect(result.socket.connected).toBe(true);
    });
  });

  describe('a connection carries the actor it authenticated as', () => {
    it('resolves roles from the database, not from the token claim', async () => {
      // The token is minted while the master grant exists, then the grant is
      // withdrawn before the socket is opened. A gateway reading `claims.roles`
      // would admit a master; `ActorService` reports what `user_roles` says
      // now. Asserting merely that the connection succeeds would pass either
      // way, which is why the roles themselves are read back.
      const caller = await signIn(['customer', 'master']);
      await db
        .delete(userRoles)
        .where(and(eq(userRoles.userId, caller.userId), eq(userRoles.role, 'master')));

      const result = await dial({ token: caller.accessToken });
      expect(result.connected).toBe(true);

      // `fetchSockets()` types `data` as `any` — it crosses the cluster as
      // msgpack, so socket.io cannot know its shape. Narrowing it here rather
      // than reaching into `any` keeps the assertion honest about what is
      // being read.
      const [socket] = await app.get(RealtimeGateway).server.fetchSockets();
      const data = socket?.data as RealtimeSocketData | undefined;

      expect(data?.actor.roles).toEqual(['customer']);
    });

    it('does not keep the access token on the socket once it has been spent', async () => {
      // The handshake is not private storage: the cluster adapter serialises
      // ALL of it into its `FETCH_SOCKETS_RESPONSE` and publishes that over
      // Redis, which ADR-0032 records as unsigned and unauthenticated. Before
      // the authenticator scrubbed it, running exactly this assertion returned
      // the caller's live bearer token.
      const caller = await signIn();
      await dial({ token: caller.accessToken });

      const sockets = await app.get(RealtimeGateway).server.fetchSockets();
      const serialised = JSON.stringify(
        sockets.map((s) => ({ handshake: s.handshake, data: s.data })),
      );

      expect(serialised).not.toContain(caller.accessToken);
    });
  });

  describe('a reconnect is a fresh authentication', () => {
    it('refuses a client whose session was revoked while it was connected', async () => {
      // The requirement is that a revoked session "must not survive inside a
      // long-lived socket". Every other revocation case here revokes BEFORE
      // the first dial, which only proves the middleware runs once. This one
      // connects successfully first, so what is under test is the reconnect.
      const caller = await signIn();
      const first = await dial({ token: caller.accessToken });
      expect(first.connected).toBe(true);

      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, caller.sessionId));

      const second = await dial({ token: caller.accessToken });

      expect(second.connected).toBe(false);
      expect(second.error).toBe(UNAUTHORIZED);
    });
  });

  describe('connections per account are bounded', () => {
    it('keeps the newest connections and drops the oldest past the cap', async () => {
      const caller = await signIn();
      const cap = app.get<AppConfig>(APP_CONFIG).realtime.maxConnectionsPerUser;

      const sockets: Socket[] = [];
      for (let i = 0; i < cap + 1; i += 1) {
        const result = await dial({ token: caller.accessToken });
        expect(result.connected).toBe(true);
        sockets.push(result.socket);
      }

      // The newest is served; the oldest is the one that pays. A client whose
      // phone dropped off a tunnel reconnects rather than being locked out by
      // the sockets the server has not noticed are dead yet.
      await expect.poll(() => sockets[0]?.connected).toBe(false);
      expect(sockets[sockets.length - 1]?.connected).toBe(true);
      expect(sockets.filter((socket) => socket.connected)).toHaveLength(cap);
    });

    // Bounding each account SEPARATELY is asserted in
    // `connection.registry.test.ts`, which can drive the cap down to 1. At the
    // configured default of 5, one socket per account would pass here even if
    // the registry counted globally.
  });
});
