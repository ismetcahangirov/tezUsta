import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/devices` over real HTTP, through the real `AppModule` graph — the same
 * construction as `addresses.e2e.test.ts`.
 *
 * What only this layer can prove: that a token registered twice leaves one
 * row rather than two, that a token moving between users takes its row with
 * it **under genuinely concurrent writes** rather than merely sequential
 * ones, that no response ever carries a full push token, and that a device id
 * belonging to a stranger is indistinguishable from one that never existed.
 * The first two are properties of a database constraint, and a unit test over
 * a mocked repository would assert the mock rather than the constraint.
 */

/** `users.phone_e164` is unique among live rows — see `addresses.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99477${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid but never-issued uuid — well-formed, guaranteed absent. */
function unknownUuid(): string {
  return randomUUID();
}

let tokenCounter = 0;
/**
 * A distinct, well-formed Expo token per call.
 *
 * Expo's own tokens carry 22 characters between the brackets; the length is
 * not something the server validates (see `devices.schema.ts` on why), but
 * generating a realistic one keeps the fixtures honest.
 */
function nextExpoToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[${String(tokenCounter).padStart(22, 'x')}]`;
}

function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

/**
 * A `devices` row as the database holds it — the only way to assert on the
 * token itself, which the API deliberately never returns.
 */
interface StoredDevice {
  readonly id: string;
  readonly expo_push_token: string;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

interface DeviceBody {
  readonly id: string;
  readonly platform: 'ios' | 'android';
  readonly tokenSuffix: string;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string;
}

describe('device registry endpoints over HTTP (issue #140)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  async function signIn(): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function del(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).delete(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function registerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      expoPushToken: nextExpoToken(),
      platform: 'android',
      ...overrides,
    };
  }

  async function register(
    accessToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<DeviceBody> {
    const res = await post('/devices', accessToken).send(registerPayload(overrides));
    expect(res.status).toBe(201);
    return res.body as DeviceBody;
  }

  async function rowsFor(userId: string): Promise<StoredDevice[]> {
    const result = await pool.query<StoredDevice>(
      'select id, expo_push_token, revoked_at, revoked_reason from devices where user_id = $1 order by created_at',
      [userId],
    );
    return result.rows;
  }

  async function rowCountForToken(token: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from devices where expo_push_token = $1',
      [token],
    );
    return Number(result.rows[0]?.count ?? '0');
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
    tokens = app.get(TokenService);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => {
      /* see addresses.e2e.test.ts — a terminated backend must not fail the run */
    });
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

  describe('registration', () => {
    it('registers a device and returns it without the token', async () => {
      const caller = await signIn();
      const token = nextExpoToken();

      const device = await register(caller.accessToken, { expoPushToken: token });

      expect(device.platform).toBe('android');
      expect(device.id).toEqual(expect.any(String));
      // The suffix is what a support conversation can name; the token is not.
      expect(token.endsWith(device.tokenSuffix)).toBe(true);
      expect(device.tokenSuffix.length).toBeLessThan(token.length);
      expect(JSON.stringify(device)).not.toContain(token);

      expect(await rowsFor(caller.userId)).toHaveLength(1);
    });

    it('keeps optional client metadata, and defaults it to null', async () => {
      const caller = await signIn();

      const withMetadata = await register(caller.accessToken, {
        deviceId: 'Pixel 7',
        appVersion: '1.4.2',
      });
      expect(withMetadata.deviceId).toBe('Pixel 7');
      expect(withMetadata.appVersion).toBe('1.4.2');

      const without = await register(caller.accessToken);
      expect(without.deviceId).toBeNull();
      expect(without.appVersion).toBeNull();
    });

    it('registering the same token twice leaves one row and one id', async () => {
      const caller = await signIn();
      const token = nextExpoToken();

      const first = await register(caller.accessToken, { expoPushToken: token });
      const second = await register(caller.accessToken, { expoPushToken: token });

      expect(second.id).toBe(first.id);
      expect(await rowCountForToken(token)).toBe(1);
      expect(await rowsFor(caller.userId)).toHaveLength(1);
      // A re-registration is the client saying "still here".
      expect(new Date(second.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.lastSeenAt).getTime(),
      );
    });

    it('updates the metadata of a token that is registered again', async () => {
      const caller = await signIn();
      const token = nextExpoToken();

      await register(caller.accessToken, { expoPushToken: token, appVersion: '1.0.0' });
      const updated = await register(caller.accessToken, {
        expoPushToken: token,
        appVersion: '1.1.0',
      });

      expect(updated.appVersion).toBe('1.1.0');
      expect(await rowCountForToken(token)).toBe(1);
    });

    it('moves a token to the user who last registered it, rather than duplicating it', async () => {
      const previousOwner = await signIn();
      const newOwner = await signIn();
      const token = nextExpoToken();

      await register(previousOwner.accessToken, { expoPushToken: token });
      expect(await rowsFor(previousOwner.userId)).toHaveLength(1);

      await register(newOwner.accessToken, { expoPushToken: token });

      // One phone, one row, one owner — the previous owner's notifications
      // must not arrive on somebody else's lock screen.
      expect(await rowCountForToken(token)).toBe(1);
      expect(await rowsFor(previousOwner.userId)).toHaveLength(0);
      expect(await rowsFor(newOwner.userId)).toHaveLength(1);

      const previousOwnerList = await get('/devices', previousOwner.accessToken);
      expect(previousOwnerList.status).toBe(200);
      expect(previousOwnerList.body).toEqual([]);
    });

    it('registers one row when the same token arrives twice at once', async () => {
      const caller = await signIn();
      const token = nextExpoToken();

      const [first, second] = await Promise.all([
        post('/devices', caller.accessToken).send({ expoPushToken: token, platform: 'ios' }),
        post('/devices', caller.accessToken).send({ expoPushToken: token, platform: 'ios' }),
      ]);

      // Neither request is allowed to lose: this is one device saying the same
      // thing twice, not a contended resource.
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await rowCountForToken(token)).toBe(1);
      expect(await rowsFor(caller.userId)).toHaveLength(1);
    });

    it('registers one row when two users claim the same token at once', async () => {
      const a = await signIn();
      const b = await signIn();
      const token = nextExpoToken();

      const [first, second] = await Promise.all([
        post('/devices', a.accessToken).send({ expoPushToken: token, platform: 'android' }),
        post('/devices', b.accessToken).send({ expoPushToken: token, platform: 'android' }),
      ]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(await rowCountForToken(token)).toBe(1);

      const owners = (await rowsFor(a.userId)).length + (await rowsFor(b.userId)).length;
      expect(owners).toBe(1);
    });

    it('keeps several devices for one user', async () => {
      const caller = await signIn();

      await register(caller.accessToken, { platform: 'android' });
      await register(caller.accessToken, { platform: 'ios' });

      const res = await get('/devices', caller.accessToken);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('token validation', () => {
    /**
     * Every shape `expo-server-sdk@7.2.0` accepts — checked against the
     * shipped `build/ExpoClient.js#isExpoPushToken`, not against the
     * documentation, which mentions only the first.
     *
     * Rejecting a shape Expo would have delivered to is the expensive
     * mistake: the phone is simply never reachable, and the failure lands at
     * registration where nobody is looking.
     */
    it.each([
      ['the documented form', 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'],
      ['the legacy prefix', 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]'],
      ['a bare uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ])('accepts %s', async (_label, token) => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: token,
        platform: 'ios',
      });
      expect(res.status).toBe(201);
    });

    it.each([
      ['an unclosed bracket', 'ExponentPushToken[aaaaaaaaaaaa'],
      ['an unknown prefix', 'FirebaseToken[aaaaaaaaaaaaaaaaaaaaaa]'],
      ['a bare word', 'not-a-token'],
      ['an empty string', ''],
      ['a truncated uuid', '3f2504e0-4f89-11d3-9a0c'],
    ])('rejects %s', async (_label, token) => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: token,
        platform: 'ios',
      });
      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown platform', async () => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: nextExpoToken(),
        platform: 'windows',
      });
      expect(res.status).toBe(422);
    });

    it('rejects a missing platform', async () => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: nextExpoToken(),
      });
      expect(res.status).toBe(422);
    });

    it('rejects client metadata longer than the column', async () => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: nextExpoToken(),
        platform: 'ios',
        deviceId: 'x'.repeat(1_000),
      });
      expect(res.status).toBe(422);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const caller = await signIn();
      const res = await post('/devices', caller.accessToken).send({
        expoPushToken: nextExpoToken(),
        platform: 'ios',
        userId: unknownUuid(),
      });
      expect(res.status).toBe(422);
    });
  });

  describe('listing and retiring', () => {
    it('lists only the caller’s own devices, newest activity first', async () => {
      const caller = await signIn();
      const stranger = await signIn();

      const older = await register(caller.accessToken);
      const newer = await register(caller.accessToken);
      await register(stranger.accessToken);

      const res = await get('/devices', caller.accessToken);
      expect(res.status).toBe(200);
      const ids = (res.body as DeviceBody[]).map((device) => device.id);
      expect(ids).toEqual([newer.id, older.id]);
    });

    it('never returns a full token in a list', async () => {
      const caller = await signIn();
      const token = nextExpoToken();
      await register(caller.accessToken, { expoPushToken: token });

      const res = await get('/devices', caller.accessToken);
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('retires a device and drops it from the list', async () => {
      const caller = await signIn();
      const device = await register(caller.accessToken);

      const res = await del(`/devices/${device.id}`, caller.accessToken);
      expect(res.status).toBe(204);

      const list = await get('/devices', caller.accessToken);
      expect(list.body).toEqual([]);

      // Retired, not deleted: the row records that it stopped receiving, and
      // why, the way `sessions.revoked_reason` does.
      const rows = await rowsFor(caller.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
      expect(rows[0]?.revoked_reason).toBe('unregistered');
    });

    it('lets a retired token be registered again', async () => {
      const caller = await signIn();
      const token = nextExpoToken();

      const device = await register(caller.accessToken, { expoPushToken: token });
      expect((await del(`/devices/${device.id}`, caller.accessToken)).status).toBe(204);

      const again = await register(caller.accessToken, { expoPushToken: token });

      // The same phone signing back in must not be permanently unreachable,
      // and must not need a second row to become reachable.
      expect(again.id).toBe(device.id);
      expect(await rowCountForToken(token)).toBe(1);
      const rows = await rowsFor(caller.userId);
      expect(rows[0]?.revoked_at).toBeNull();
      expect(rows[0]?.revoked_reason).toBeNull();
    });

    it('answers a second delete the same way as an unknown id', async () => {
      const caller = await signIn();
      const device = await register(caller.accessToken);
      expect((await del(`/devices/${device.id}`, caller.accessToken)).status).toBe(204);

      const second = await del(`/devices/${device.id}`, caller.accessToken);
      const unknown = await del(`/devices/${unknownUuid()}`, caller.accessToken);

      expect(second.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(envelopeWithoutRequestId(second.body)).toEqual(envelopeWithoutRequestId(unknown.body));
    });

    it('cannot retire a stranger’s device, and cannot tell that it exists', async () => {
      const owner = await signIn();
      const stranger = await signIn();
      const device = await register(owner.accessToken);

      const theirs = await del(`/devices/${device.id}`, stranger.accessToken);
      const absent = await del(`/devices/${unknownUuid()}`, stranger.accessToken);

      expect(theirs.status).toBe(404);
      expect(envelopeWithoutRequestId(theirs.body)).toEqual(envelopeWithoutRequestId(absent.body));

      // And the owner still has it.
      const list = await get('/devices', owner.accessToken);
      expect(list.body).toHaveLength(1);
    });

    it('rejects a device id that is not a uuid', async () => {
      const caller = await signIn();
      const res = await del('/devices/not-a-uuid', caller.accessToken);
      expect(res.status).toBe(422);
    });
  });

  describe('authentication', () => {
    it('refuses every route without a token', async () => {
      const unauthenticated = await Promise.all([
        post('/devices').send(registerPayload()),
        get('/devices'),
        del(`/devices/${unknownUuid()}`),
      ]);

      for (const res of unauthenticated) {
        expect(res.status).toBe(401);
      }
    });
  });
});
