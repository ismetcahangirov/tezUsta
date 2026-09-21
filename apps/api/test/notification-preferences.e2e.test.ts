import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { NotificationPreference } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { NOTIFICATION_CATEGORIES } from '../src/modules/notifications/notification-categories';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/notification-preferences` over real HTTP, through the real `AppModule`
 * graph — the same construction as `devices.e2e.test.ts`.
 *
 * What only this layer can prove: that a user who has stored nothing is
 * answered with every category rather than an empty list, that a write is
 * refused at the boundary for a category the server does not know, that a
 * transactional category cannot be silenced through the API, and that no
 * route accepts a user id — the ownership guarantee is the absence of a
 * parameter, which only a request can demonstrate.
 */

/** `users.phone_e164` is unique among live rows — see `addresses.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99451${String(phoneCounter).padStart(7, '0')}`;
}

function envelope(body: unknown): ErrorEnvelope['error'] {
  return (body as ErrorEnvelope).error;
}

describe('notification preference endpoints over HTTP (issue #143)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  async function signIn(): Promise<SignedIn> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function put(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).put(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function storedRowCount(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from notification_preferences where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function read(accessToken: string): Promise<NotificationPreference[]> {
    const res = await get('/notification-preferences', accessToken).expect(200);
    return res.body as NotificationPreference[];
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database?.drop();
  });

  describe('reading', () => {
    it('answers a user who has stored nothing with every category, all on', async () => {
      const user = await signIn();

      const body = await read(user.accessToken);

      expect(body).toHaveLength(NOTIFICATION_CATEGORIES.length);
      expect(body.every((preference) => preference.enabled)).toBe(true);
      expect(await storedRowCount(user.userId)).toBe(0);
    });

    it('says which categories the user may change', async () => {
      const user = await signIn();

      const body = await read(user.accessToken);
      const progress = body.find((preference) => preference.category === 'order-progress');
      const accepted = body.find((preference) => preference.category === 'order-accepted');

      expect(progress?.changeable).toBe(true);
      expect(accepted?.changeable).toBe(false);
    });

    it('refuses an unauthenticated read', async () => {
      await get('/notification-preferences').expect(401);
    });
  });

  describe('writing', () => {
    it('switches a category off and reads it back', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-progress', enabled: false }] })
        .expect(200);

      const body = await read(user.accessToken);
      const others = body.filter((preference) => preference.category !== 'order-progress');

      expect(body.find((preference) => preference.category === 'order-progress')?.enabled).toBe(
        false,
      );
      expect(others.every((preference) => preference.enabled)).toBe(true);
    });

    it('answers the write with the same shape the read returns', async () => {
      const user = await signIn();

      const written = await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-progress', enabled: false }] })
        .expect(200);

      expect(written.body).toEqual(await read(user.accessToken));
    });

    /**
     * The body is the complete set, not a patch: a category it does not name
     * goes back to its default. Without this the stored rows would only ever
     * grow, and a client could never undo a choice except by naming it again.
     */
    it('returns a category the body omits to its default', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-progress', enabled: false }] })
        .expect(200);
      await put('/notification-preferences', user.accessToken)
        .send({ preferences: [] })
        .expect(200);

      const body = await read(user.accessToken);

      expect(body.every((preference) => preference.enabled)).toBe(true);
      expect(await storedRowCount(user.userId)).toBe(0);
    });

    it('is idempotent — the same write twice leaves one row', async () => {
      const user = await signIn();
      const body = { preferences: [{ category: 'order-progress', enabled: false }] };

      await put('/notification-preferences', user.accessToken).send(body).expect(200);
      await put('/notification-preferences', user.accessToken).send(body).expect(200);

      expect(await storedRowCount(user.userId)).toBe(1);
    });

    it('rejects a category the server does not know, at the boundary', async () => {
      const user = await signIn();

      const res = await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'promotions', enabled: false }] })
        .expect(422);

      expect(envelope(res.body).code).toBe('VALIDATION_FAILED');
      expect(await storedRowCount(user.userId)).toBe(0);
    });

    it('rejects an unknown field rather than dropping it', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-progress', enabled: false, sound: 'chime' }] })
        .expect(422);
    });

    it('rejects the same category named twice', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({
          preferences: [
            { category: 'order-progress', enabled: false },
            { category: 'order-progress', enabled: true },
          ],
        })
        .expect(422);
    });

    it('refuses to switch off a category that may not be switched off', async () => {
      const user = await signIn();

      const res = await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-accepted', enabled: false }] })
        .expect(409);

      expect(envelope(res.body).code).toBe('NOTIFICATION_CATEGORY_NOT_CHANGEABLE');
      expect(await storedRowCount(user.userId)).toBe(0);
    });

    /**
     * The whole body applies or none of it does. A partial write would leave
     * the user looking at a settings screen that agrees with neither what they
     * asked for nor what they had.
     */
    it('applies nothing when one entry in the body is refused', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({
          preferences: [
            { category: 'order-progress', enabled: false },
            { category: 'order-accepted', enabled: false },
          ],
        })
        .expect(409);

      const body = await read(user.accessToken);

      expect(body.every((preference) => preference.enabled)).toBe(true);
    });

    it('accepts switching a non-changeable category on, which changes nothing', async () => {
      const user = await signIn();

      await put('/notification-preferences', user.accessToken)
        .send({ preferences: [{ category: 'order-accepted', enabled: true }] })
        .expect(200);

      const body = await read(user.accessToken);

      expect(body.every((preference) => preference.enabled)).toBe(true);
    });

    it('refuses an unauthenticated write', async () => {
      await put('/notification-preferences').send({ preferences: [] }).expect(401);
    });
  });

  describe('ownership', () => {
    it('leaves another user untouched', async () => {
      const mine = await signIn();
      const theirs = await signIn();

      await put('/notification-preferences', mine.accessToken)
        .send({ preferences: [{ category: 'order-progress', enabled: false }] })
        .expect(200);

      const body = await read(theirs.accessToken);

      expect(body.every((preference) => preference.enabled)).toBe(true);
      expect(await storedRowCount(theirs.userId)).toBe(0);
    });

    /**
     * There is no user id anywhere in this surface to send, which is the
     * guarantee rather than a check somebody has to remember. A body that
     * tries to name an owner is refused rather than ignored.
     */
    it('refuses a body that tries to name an owner', async () => {
      const mine = await signIn();
      const theirs = await signIn();

      await put('/notification-preferences', mine.accessToken)
        .send({
          userId: theirs.userId,
          preferences: [{ category: 'order-progress', enabled: false }],
        })
        .expect(422);
    });
  });
});
