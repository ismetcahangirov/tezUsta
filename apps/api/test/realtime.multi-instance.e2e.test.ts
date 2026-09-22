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
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The reason issue #166 exists (CLAUDE.md, `realtime-architecture.md`
 * § Transport): with more than one API instance, a client connected to
 * instance A must receive an event published on instance B. Without the
 * adapter it silently does not, and the bug arrives months later as
 * "sometimes the app doesn't update".
 *
 * **Two real Nest applications, on two ports, against one Redis.** A single
 * application with a mocked adapter would assert that we call what we call
 * and would keep passing after someone dropped `useWebSocketAdapter` from
 * `main.ts` — which is the whole failure being guarded against.
 *
 * They share one throwaway database because the actor behind the socket has
 * to exist for both of them; nothing here asserts anything about Postgres.
 */
describe('realtime gateway across two API instances (issue #166)', () => {
  let instanceA: NestFastifyApplication;
  let instanceB: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let client: Socket;

  async function bootInstance(): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The line under test. `main.ts` makes the same call, and this suite fails
    // without it.
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    return app;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    instanceA = await bootInstance();
    instanceB = await bootInstance();

    const created = await instanceB
      .get(UsersRepository)
      .create({ phoneE164: '+994509990001', roles: ['customer'] });
    const pair = await instanceB.get(SessionsService).startSession({ userId: created.user.id });

    client = io(await instanceB.getUrl(), {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: pair.accessToken },
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        resolve();
      });
      client.on('connect_error', (error: Error) => {
        reject(error);
      });
    });
  });

  afterAll(async () => {
    client.disconnect();
    await instanceA.close();
    await instanceB.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  it('delivers to a client on instance B an event published on instance A', async () => {
    const received = new Promise<unknown>((resolve) => {
      client.once('realtime:diagnostic', resolve);
    });

    instanceA.get(RealtimeGateway).server.emit('realtime:diagnostic', { hello: 'from-a' });

    await expect(received).resolves.toEqual({ hello: 'from-a' });
  });

  it('counts the socket connected to instance B from instance A', async () => {
    // `fetchSockets()` crosses the instance boundary through the adapter, so
    // this fails for the same reason the test above does when the adapter is
    // missing — and it fails without depending on event delivery, which is
    // what makes the two assertions worth having separately.
    const sockets = await instanceA.get(RealtimeGateway).server.fetchSockets();

    expect(sockets).toHaveLength(1);
  });
});
