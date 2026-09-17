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
 * `/addresses` over real HTTP, through the real `AppModule` graph — the same
 * construction as `customer-profile.e2e.test.ts`, which this file follows
 * closely because addresses hang directly off a customer profile.
 *
 * What only this layer can prove: that every route sits behind
 * authentication, that the default-address invariant ("a customer with
 * addresses always has exactly one default") holds under real concurrent
 * writes and not merely under sequential ones, that `GET/PATCH/DELETE
 * /addresses/:id` cannot be used to probe whether a stranger's address
 * exists, and that the coordinate actually stored in PostGIS is the one the
 * caller sent — not merely the one echoed back over JSON. None of that is
 * visible from a unit test of a service in isolation.
 */

/** `users.phone_e164` is unique among live rows — see `customer-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

/** A syntactically valid but never-issued uuid — well-formed, guaranteed absent. */
function unknownUuid(): string {
  return randomUUID();
}

/**
 * The error envelope minus its `requestId` — fresh per request by design, and
 * therefore the only field that may legitimately differ between two
 * responses that must otherwise be indistinguishable. Copied from
 * `customer-profile.e2e.test.ts`.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}

interface AddressBody {
  readonly id: string;
  readonly label: string | null;
  readonly formattedAddress: string;
  readonly building: string | null;
  readonly entrance: string | null;
  readonly floor: string | null;
  readonly apartment: string | null;
  readonly landmarkNote: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Baku city centre — a real, precise coordinate, not a rounded placeholder. */
const BAKU_LATITUDE = 40.409264;
const BAKU_LONGITUDE = 49.867092;

function baseAddressPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formattedAddress: 'Nizami küçəsi 203',
    latitude: BAKU_LATITUDE,
    longitude: BAKU_LONGITUDE,
    ...overrides,
  };
}

describe('address endpoints over HTTP (issue #35)', () => {
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
    // Sanity check on the harness itself, not the system under test: a
    // malformed access token here would make every 401 assertion below
    // meaningless because the token was never going to authenticate anyway.
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

  function patch(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).patch(path);
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

  /** Signs in a fresh user and creates a customer profile for it in one step. */
  async function signInAsCustomer(): Promise<SignedIn> {
    const caller = await signIn();
    const res = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(res.status).toBe(201);
    return caller;
  }

  async function createAddress(
    accessToken: string,
    overrides: Record<string, unknown> = {},
  ): Promise<AddressBody> {
    const res = await post('/addresses', accessToken).send(baseAddressPayload(overrides));
    expect(res.status).toBe(201);
    return res.body as AddressBody;
  }

  async function defaultCount(customerId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from addresses where customer_id = $1 and is_default and deleted_at is null',
      [customerId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function customerIdOf(userId: string): Promise<string> {
    const result = await pool.query<{ id: string }>('select id from customers where user_id = $1', [
      userId,
    ]);
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error(`no customer row for user ${userId}`);
    }
    return id;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Point the real `ConfigModule` at the throwaway database rather than
    // overriding `DATABASE_CONNECTION`, so the wiring under test is the
    // application's own — see the same note in `customer-profile.e2e.test.ts`.
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
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  describe('POST /addresses', () => {
    it('requires authentication', async () => {
      const res = await post('/addresses').send(baseAddressPayload());
      expect(res.status).toBe(401);
    });

    it('answers 404 for a caller with no customer profile', async () => {
      // There is no customer row to hang the address on yet — `signIn()`
      // alone does not create one (see `customer-profile.e2e.test.ts`).
      const caller = await signIn();

      const res = await post('/addresses', caller.accessToken).send(baseAddressPayload());

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });

    it('creates an address and returns exactly the documented wire shape', async () => {
      const caller = await signInAsCustomer();

      const res = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ label: 'Ev' }),
      );

      expect(res.status).toBe(201);
      const body = res.body as AddressBody;
      expect(body.formattedAddress).toBe('Nizami küçəsi 203');
      expect(body.label).toBe('Ev');
      expect(typeof body.id).toBe('string');
      expect(Date.parse(body.createdAt)).not.toBeNaN();
      expect(Date.parse(body.updatedAt)).not.toBeNaN();
      // No `customerId`, no `deletedAt`, no `position` — a response is not a
      // row dump.
      expect(Object.keys(body).sort()).toEqual(
        [
          'apartment',
          'building',
          'createdAt',
          'entrance',
          'floor',
          'formattedAddress',
          'id',
          'isDefault',
          'label',
          'landmarkNote',
          'latitude',
          'longitude',
          'updatedAt',
        ].sort(),
      );
    });

    it('makes the customer’s first live address the default even when isDefault is absent', async () => {
      const caller = await signInAsCustomer();

      const created = await createAddress(caller.accessToken);

      expect(created.isDefault).toBe(true);
    });

    it('makes the first live address the default even when isDefault is explicitly false', async () => {
      // The invariant is "a customer with addresses always has exactly one
      // default" — the very first address cannot opt out of that.
      const caller = await signInAsCustomer();

      const created = await createAddress(caller.accessToken, { isDefault: false });

      expect(created.isDefault).toBe(true);
    });

    it('moves the default to a later address created with isDefault: true, demoting the previous one', async () => {
      const caller = await signInAsCustomer();
      const first = await createAddress(caller.accessToken, { label: 'Ev' });
      expect(first.isDefault).toBe(true);

      const second = await createAddress(caller.accessToken, {
        label: 'İş',
        isDefault: true,
      });
      expect(second.isDefault).toBe(true);

      const list = (await get('/addresses', caller.accessToken)).body as AddressBody[];
      const reloadedFirst = list.find((a) => a.id === first.id);
      expect(reloadedFirst?.isDefault).toBe(false);

      const customerId = await customerIdOf(caller.userId);
      expect(await defaultCount(customerId)).toBe(1);
    });

    it('rejects a 51st live address with 409 CONFLICT', async () => {
      const caller = await signInAsCustomer();
      for (let i = 0; i < 50; i += 1) {
        await createAddress(caller.accessToken, { label: `Ünvan ${i}` });
      }

      const res = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ label: 'Ünvan 51' }),
      );

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
    }, 30_000);

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signInAsCustomer();

      const res = await post('/addresses', caller.accessToken).send({
        ...baseAddressPayload(),
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a missing, empty, whitespace-only or oversized formattedAddress', async () => {
      const caller = await signInAsCustomer();

      const missing = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ formattedAddress: undefined }),
      );
      const empty = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ formattedAddress: '' }),
      );
      const whitespaceOnly = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ formattedAddress: '   ' }),
      );
      const oversized = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ formattedAddress: 'x'.repeat(301) }),
      );

      for (const res of [missing, empty, whitespaceOnly, oversized]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects an oversized entrance (41 chars) — structured fields are bounded too', async () => {
      const caller = await signInAsCustomer();

      const res = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ entrance: 'x'.repeat(41) }),
      );

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an out-of-range latitude or longitude', async () => {
      const caller = await signInAsCustomer();

      const badLatitude = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ latitude: 91 }),
      );
      const badLongitude = await post('/addresses', caller.accessToken).send(
        baseAddressPayload({ longitude: 181 }),
      );

      expect(badLatitude.status).toBe(422);
      expect((badLatitude.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      expect(badLongitude.status).toBe(422);
      expect((badLongitude.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('persists the structured Azerbaijani fields and returns them unchanged on GET', async () => {
      // `entrance`, `floor` and `apartment` are strings on purpose — "2",
      // "giriş 2" and "5A" are all real Azerbaijani address components, not
      // integers with a cosmetic string wrapper.
      const caller = await signInAsCustomer();

      const created = await createAddress(caller.accessToken, {
        building: '12B',
        entrance: '2',
        floor: '5',
        apartment: '48',
        landmarkNote: 'Market-in yanı',
      });

      const reread = (await get(`/addresses/${created.id}`, caller.accessToken))
        .body as AddressBody;

      expect(reread.building).toBe('12B');
      expect(reread.entrance).toBe('2');
      expect(reread.floor).toBe('5');
      expect(reread.apartment).toBe('48');
      expect(reread.landmarkNote).toBe('Market-in yanı');
    });

    it('round-trips a precise Baku coordinate through HTTP and through the stored PostGIS geometry', async () => {
      const caller = await signInAsCustomer();

      const created = await createAddress(caller.accessToken);

      // The HTTP contract: what the caller sent is what a re-read hands back,
      // to ~6 decimal places (roughly 11cm at this latitude — far tighter
      // than GPS accuracy, so any looser and the round-trip would be
      // meaningless).
      expect(created.latitude).toBeCloseTo(BAKU_LATITUDE, 6);
      expect(created.longitude).toBeCloseTo(BAKU_LONGITUDE, 6);

      // The database contract: the geometry actually stored is a WGS84
      // (SRID 4326) point built as `ST_MakePoint(lng, lat)` — X is
      // longitude, Y is latitude, not the reverse. Asserting only the JSON
      // response would miss a swapped-axis bug that happens to survive the
      // trip back out through the same (also swapped) read path.
      const geometryRow = await pool.query<{ x: number; y: number; srid: number }>(
        'select ST_X(position) as x, ST_Y(position) as y, ST_SRID(position) as srid from addresses where id = $1',
        [created.id],
      );
      const row = geometryRow.rows[0];
      expect(row).toBeDefined();
      expect(row?.x).toBeCloseTo(BAKU_LONGITUDE, 6);
      expect(row?.y).toBeCloseTo(BAKU_LATITUDE, 6);
      expect(row?.srid).toBe(4326);
    });
  });

  describe('GET /addresses', () => {
    it('requires authentication', async () => {
      const res = await get('/addresses');
      expect(res.status).toBe(401);
    });

    it('returns a plain array, default first then newest first, excluding soft-deleted rows', async () => {
      const caller = await signInAsCustomer();
      const first = await createAddress(caller.accessToken, { label: 'Birinci' });
      const second = await createAddress(caller.accessToken, { label: 'İkinci' });
      const third = await createAddress(caller.accessToken, {
        label: 'Üçüncü',
        isDefault: true,
      });
      // Soft-deleted — must never appear in the list.
      await del(`/addresses/${second.id}`, caller.accessToken);

      const res = await get('/addresses', caller.accessToken);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const list = res.body as AddressBody[];
      const ids = list.map((a) => a.id);
      expect(ids).not.toContain(second.id);
      // `third` is the current default and must sort first; `first` is the
      // only other live address and follows.
      expect(ids[0]).toBe(third.id);
      expect(ids).toContain(first.id);
      expect(list).toHaveLength(2);
    });

    it('never returns another customer’s addresses', async () => {
      const owner = await signInAsCustomer();
      await createAddress(owner.accessToken, { label: 'Sahibin ünvanı' });
      const stranger = await signInAsCustomer();
      await createAddress(stranger.accessToken, { label: 'Yadın ünvanı' });

      const ownerList = (await get('/addresses', owner.accessToken)).body as AddressBody[];

      expect(ownerList).toHaveLength(1);
      expect(ownerList[0]?.label).toBe('Sahibin ünvanı');
    });
  });

  describe('GET /addresses/:id', () => {
    it('requires authentication', async () => {
      const res = await get(`/addresses/${unknownUuid()}`);
      expect(res.status).toBe(401);
    });

    it('returns the caller’s own address', async () => {
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken, { label: 'Ev' });

      const res = await get(`/addresses/${created.id}`, caller.accessToken);

      expect(res.status).toBe(200);
      expect((res.body as AddressBody).id).toBe(created.id);
      expect((res.body as AddressBody).label).toBe('Ev');
    });

    it('answers 422, not 500, for an id that is not a uuid', async () => {
      const caller = await signInAsCustomer();

      const res = await get('/addresses/not-a-uuid', caller.accessToken);

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it(
      'answers 404 — not 403 — for another customer’s address, with a body byte-identical ' +
        'to a genuinely unknown id',
      async () => {
        // The whole control: a 403 here would confirm the id belongs to
        // *someone*, turning the endpoint into an oracle a stranger could
        // walk sequential or guessed ids against to enumerate real
        // addresses. A 404 that differs in any byte from the 404 for an id
        // nobody ever used is the same leak in a smaller disguise, which is
        // why the comparison is on the full envelope (minus the
        // per-request `requestId`), not just the status code.
        const owner = await signInAsCustomer();
        const ownerAddress = await createAddress(owner.accessToken);

        const stranger = await signInAsCustomer();

        const notYours = await get(`/addresses/${ownerAddress.id}`, stranger.accessToken);
        const neverExisted = await get(`/addresses/${unknownUuid()}`, stranger.accessToken);

        expect(notYours.status).toBe(404);
        expect(neverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(notYours.body)).toEqual(
          envelopeWithoutRequestId(neverExisted.body),
        );
      },
    );
  });

  describe('PATCH /addresses/:id', () => {
    it('requires authentication', async () => {
      const res = await patch(`/addresses/${unknownUuid()}`).send({ label: 'Yeni' });
      expect(res.status).toBe(401);
    });

    it('rejects an empty body — at least one field is required', async () => {
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken);

      const res = await patch(`/addresses/${created.id}`, caller.accessToken).send({});

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken);

      const res = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('updates a field and persists it', async () => {
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken, { label: 'Köhnə' });

      const res = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        label: 'Yeni',
      });

      expect(res.status).toBe(200);
      expect((res.body as AddressBody).label).toBe('Yeni');

      const reread = (await get(`/addresses/${created.id}`, caller.accessToken))
        .body as AddressBody;
      expect(reread.label).toBe('Yeni');
    });

    it('promotes an address to default and atomically demotes the previous default', async () => {
      const caller = await signInAsCustomer();
      const first = await createAddress(caller.accessToken, { label: 'Birinci' });
      const second = await createAddress(caller.accessToken, { label: 'İkinci' });
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);

      const res = await patch(`/addresses/${second.id}`, caller.accessToken).send({
        isDefault: true,
      });

      expect(res.status).toBe(200);
      expect((res.body as AddressBody).isDefault).toBe(true);

      const rereadFirst = (await get(`/addresses/${first.id}`, caller.accessToken))
        .body as AddressBody;
      expect(rereadFirst.isDefault).toBe(false);

      const customerId = await customerIdOf(caller.userId);
      expect(await defaultCount(customerId)).toBe(1);
    });

    it('clears an optional field when the client sends an explicit null', async () => {
      // Omitting a field and sending null are different requests: the first
      // says "leave it alone", the second says "remove it". Without the
      // second, a customer who typed the wrong apartment number has no way to
      // take it back short of deleting the address and retyping it.
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken, { apartment: '48', floor: '5' });
      expect(created.apartment).toBe('48');

      const res = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        apartment: null,
      });

      expect(res.status).toBe(200);
      expect((res.body as AddressBody).apartment).toBeNull();
      // The neighbouring field was not touched — a clear is one field, not a
      // reset of everything the request did not mention.
      expect((res.body as AddressBody).floor).toBe('5');

      const reread = (await get(`/addresses/${created.id}`, caller.accessToken))
        .body as AddressBody;
      expect(reread.apartment).toBeNull();
    });

    it('refuses to move one half of a coordinate', async () => {
      // Latitude and longitude are one value in two columns. Accepting one
      // alone would let a client that thought it was fixing a typo move the
      // pin a thousand kilometres, and both halves would still pass every
      // bound check on their own.
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken);

      const latOnly = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        latitude: 41.1,
      });
      const lngOnly = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        longitude: 47.2,
      });

      for (const res of [latOnly, lngOnly]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }

      const reread = (await get(`/addresses/${created.id}`, caller.accessToken))
        .body as AddressBody;
      expect(reread.latitude).toBeCloseTo(BAKU_LATITUDE, 6);
    });

    it('rejects isDefault: false on the current default with 409 CONFLICT', async () => {
      // A customer with any live addresses always has exactly one default —
      // there is no valid state reached by simply turning the flag off. The
      // caller has to promote a different address instead.
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken);
      expect(created.isDefault).toBe(true);

      const res = await patch(`/addresses/${created.id}`, caller.accessToken).send({
        isDefault: false,
      });

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');

      const reread = (await get(`/addresses/${created.id}`, caller.accessToken))
        .body as AddressBody;
      expect(reread.isDefault).toBe(true);
    });

    it('answers 404 for another customer’s address', async () => {
      const owner = await signInAsCustomer();
      const ownerAddress = await createAddress(owner.accessToken);
      const stranger = await signInAsCustomer();

      const res = await patch(`/addresses/${ownerAddress.id}`, stranger.accessToken).send({
        label: 'Ələ keçirmə cəhdi',
      });

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });

    it(
      'lets exactly one PATCH win when two concurrent requests each try to become the ' + 'default',
      async () => {
        // This is the test the partial unique index on
        // `addresses (customer_id) WHERE is_default AND deleted_at IS NULL`
        // exists for. A sequential pair of PATCHes would pass even against
        // an implementation that reads "the current default", demotes it,
        // then writes the new one as two separate statements — the race only
        // shows up when both requests read the pre-change state at the same
        // moment and both then try to promote themselves. Firing them
        // together with `Promise.all` is what actually exercises the
        // database's own concurrency control (the unique index, or an
        // equivalent transactional guard) instead of merely trusting that
        // the code "looks" atomic.
        const caller = await signInAsCustomer();
        const first = await createAddress(caller.accessToken, { label: 'Birinci' });
        const second = await createAddress(caller.accessToken, { label: 'İkinci' });

        const results = await Promise.all([
          patch(`/addresses/${first.id}`, caller.accessToken).send({ isDefault: true }),
          patch(`/addresses/${second.id}`, caller.accessToken).send({ isDefault: true }),
        ]);

        // Neither request may fail with a server error — the index/guard
        // must resolve the race as a legitimate outcome (one succeeds, or
        // both succeed serialized by the transaction), never as a crash.
        for (const res of results) {
          expect(res.status).toBeLessThan(500);
        }

        const customerId = await customerIdOf(caller.userId);
        expect(await defaultCount(customerId)).toBe(1);
      },
    );
  });

  describe('DELETE /addresses/:id', () => {
    it('requires authentication', async () => {
      const res = await del(`/addresses/${unknownUuid()}`);
      expect(res.status).toBe(401);
    });

    it('answers 204 and makes the address unreachable afterwards', async () => {
      const caller = await signInAsCustomer();
      const first = await createAddress(caller.accessToken, { label: 'Birinci' });
      // A second address so deleting the first does not leave the customer
      // with zero live addresses — that path is covered separately below.
      await createAddress(caller.accessToken, { label: 'İkinci' });

      const res = await del(`/addresses/${first.id}`, caller.accessToken);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      expect((await get(`/addresses/${first.id}`, caller.accessToken)).status).toBe(404);
      const list = (await get('/addresses', caller.accessToken)).body as AddressBody[];
      expect(list.map((a) => a.id)).not.toContain(first.id);
    });

    it('promotes the oldest remaining live address to default when the default is deleted', async () => {
      const caller = await signInAsCustomer();
      const first = await createAddress(caller.accessToken, { label: 'Birinci' });
      const second = await createAddress(caller.accessToken, { label: 'İkinci' });
      const third = await createAddress(caller.accessToken, { label: 'Üçüncü' });
      expect(first.isDefault).toBe(true);

      const res = await del(`/addresses/${first.id}`, caller.accessToken);
      expect(res.status).toBe(204);

      const list = (await get('/addresses', caller.accessToken)).body as AddressBody[];
      const newDefault = list.find((a) => a.isDefault);
      // `second` is the oldest of the two remaining live addresses.
      expect(newDefault?.id).toBe(second.id);
      expect(list.find((a) => a.id === third.id)?.isDefault).toBe(false);

      const customerId = await customerIdOf(caller.userId);
      expect(await defaultCount(customerId)).toBe(1);
    });

    it('answers 404 for another customer’s address', async () => {
      const owner = await signInAsCustomer();
      const ownerAddress = await createAddress(owner.accessToken);
      const stranger = await signInAsCustomer();

      const res = await del(`/addresses/${ownerAddress.id}`, stranger.accessToken);

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });

    it('answers 404 on a second delete of the same address', async () => {
      const caller = await signInAsCustomer();
      const created = await createAddress(caller.accessToken);

      expect((await del(`/addresses/${created.id}`, caller.accessToken)).status).toBe(204);
      const second = await del(`/addresses/${created.id}`, caller.accessToken);

      expect(second.status).toBe(404);
      expect((second.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });
  });
});
