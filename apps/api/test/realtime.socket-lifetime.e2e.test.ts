import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * A socket may not outlive the credential that opened it (issue #166).
 *
 * The actor on a socket is resolved once, at connect, and then frozen. A phone
 * left on a screen holds that snapshot for hours — so without a bound, an
 * admin suspending a master mid-shift would not reach them, and "a revoked
 * session must not survive inside a long-lived socket" would be true only of
 * clients that happened to reconnect.
 *
 * The bound is the access token's own `exp`. This suite drives
 * `JWT_ACCESS_TTL` down to the schema's minimum so the behaviour can be
 * observed in seconds rather than in fifteen minutes — which is also why it is
 * a separate file: it needs its own environment, and therefore its own
 * application.
 */
describe('realtime socket lifetime (issue #166)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalAccessTtl: string | undefined;
  let client: Socket;

  /** The schema's floor for `JWT_ACCESS_TTL` — below a minute is refused. */
  const ACCESS_TTL = '60s';

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    originalAccessTtl = process.env.JWT_ACCESS_TTL;
    process.env.DATABASE_URL = database.url;
    process.env.JWT_ACCESS_TTL = ACCESS_TTL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    client.disconnect();
    await app.close();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalAccessTtl === undefined) {
      delete process.env.JWT_ACCESS_TTL;
    } else {
      process.env.JWT_ACCESS_TTL = originalAccessTtl;
    }

    await database.drop();
  });

  it('closes a connected socket when its access token expires', async () => {
    const created = await app
      .get(UsersRepository)
      .create({ phoneE164: '+994509995555', roles: ['customer'] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });

    client = io(await app.getUrl(), {
      transports: ['websocket'],
      // Without this the client would immediately dial again with the same
      // expired token, and "did it close?" would race a reconnect.
      reconnection: false,
      auth: { token: pair.accessToken },
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        resolve();
      });
      client.on('connect_error', reject);
    });
    expect(client.connected).toBe(true);

    // The server closes it at `exp`, not on any action by the client: nothing
    // is sent, nothing is asked for, and the socket still goes.
    //
    // The margin over the 60 s TTL is deliberately wide. `pnpm verify` runs
    // this alongside a mobile Jest run that saturates the CPU, and a timeout
    // that merely clears the TTL on an idle machine is how a real assertion
    // becomes an intermittent red build. It does not weaken the test: the
    // socket must still close without the client touching it.
    await expect.poll(() => client.connected, { timeout: 120_000, interval: 500 }).toBe(false);
  }, 150_000);
});
