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
import type { UserRoleName } from '../src/infra/database/schema/users';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/masters` over real HTTP, through the real `AppModule` graph — the same
 * construction as `customer-profile.e2e.test.ts` and `addresses.e2e.test.ts`,
 * which this file follows closely.
 *
 * What only this layer can prove: that every route actually sits behind
 * authentication, that `POST /masters` is idempotent and grants the `master`
 * role in the same transaction it writes the profile, that a role granted
 * mid-session is honoured without a fresh token (roles are re-read from
 * `user_roles` on every request, not cached in the claim), that a soft-deleted
 * profile is revived rather than duplicated, that `GET /masters/:id` cannot be
 * used to probe whether a stranger's profile exists, and that the
 * fixed-vs-inspection pricing rule is enforced against the row a write would
 * *result in*, not merely the fields the request happened to send. None of
 * that is visible from a unit test of the service in isolation.
 */

/** `users.phone_e164` is unique among live rows — see `customer-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
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

interface MasterBody {
  readonly id: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly verificationStatus: string;
  readonly suspendedAt: string | null;
  readonly isAvailable: boolean;
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MasterServiceBody {
  readonly serviceId: string;
  readonly priceMinor: number | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

describe('master profile and offered-service endpoints over HTTP (issue #37)', () => {
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

  async function signIn(roles: readonly UserRoleName[] = []): Promise<SignedIn> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles });
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

  /** Signs in a fresh user and creates a master profile for it in one step. */
  async function signInAsMaster(): Promise<SignedIn> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(res.status).toBe(201);
    return caller;
  }

  async function masterRowCount(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from masters where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Inserts a fresh catalogue category, unrelated to any other test's rows —
   * each service test creates its own so tests never contend over shared
   * catalogue state.
   */
  async function insertCategory(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into service_categories (id, slug, name, display_order)
       values ($1, $2, $3, 0)`,
      [id, `cat-${id}`, JSON.stringify({ az: 'Test kateqoriyası' })],
    );
    return id;
  }

  /**
   * Inserts a catalogue service with exactly the pricing shape and active
   * flag a test needs — direct Drizzle-table SQL rather than the seed script,
   * so a test never depends on a seeded slug staying what it is today.
   */
  async function insertCatalogueService(overrides: {
    pricingKind: 'fixed' | 'inspection';
    basePriceMinor?: number;
    isActive?: boolean;
  }): Promise<string> {
    const categoryId = await insertCategory();
    const id = randomUUID();
    const basePriceMinor =
      overrides.pricingKind === 'fixed' ? (overrides.basePriceMinor ?? 1500) : null;
    await pool.query(
      `insert into services (id, category_id, slug, name, pricing_kind, base_price_minor, display_order, is_active)
       values ($1, $2, $3, $4, $5, $6, 0, $7)`,
      [
        id,
        categoryId,
        `svc-${id}`,
        JSON.stringify({ az: 'Test xidməti' }),
        overrides.pricingKind,
        basePriceMinor,
        overrides.isActive ?? true,
      ],
    );
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
    // No `error` listener would mean a terminated backend — which is what
    // `ThrowawayDatabase.drop` does to a leaked session — surfaces as an
    // unhandled rejection and fails the whole run with a message naming no
    // test. Cheap insurance on a pool that only exists to inspect rows.
    pool.on('error', () => undefined);
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

  describe('POST /masters', () => {
    it('requires authentication', async () => {
      const res = await post('/masters');
      expect(res.status).toBe(401);
    });

    it('creates a profile, returns exactly the documented wire shape, and grants the master role', async () => {
      const caller = await signIn();

      const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });

      expect(res.status).toBe(201);
      const body = res.body as MasterBody;
      expect(body.displayName).toBe('Usta Anar');
      expect(typeof body.id).toBe('string');
      expect(Date.parse(body.createdAt)).not.toBeNaN();
      expect(Date.parse(body.updatedAt)).not.toBeNaN();
      // No `userId`, no `deletedAt`, no `ratingSum` — a profile response is
      // the `Master` contract (`packages/types/src/master.ts`), not a row
      // dump.
      expect(Object.keys(body).sort()).toEqual(
        [
          'bio',
          'createdAt',
          'displayName',
          'id',
          'isAvailable',
          'ratingAverage',
          'ratingCount',
          'suspendedAt',
          'updatedAt',
          'verificationStatus',
        ].sort(),
      );
    });

    it('starts a new master pending verification, unavailable, unrated and not suspended', async () => {
      const caller = await signIn();

      const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });

      const body = res.body as MasterBody;
      expect(body.verificationStatus).toBe('pending_verification');
      expect(body.isAvailable).toBe(false);
      expect(body.ratingAverage).toBeNull();
      expect(body.ratingCount).toBe(0);
      expect(body.suspendedAt).toBeNull();
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signIn();

      const res = await post('/masters', caller.accessToken).send({
        displayName: 'Usta Anar',
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('is idempotent: a second call by the same user returns 200 and the same id, with no duplicate row', async () => {
      const caller = await signIn();

      const first = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
      expect(first.status).toBe(201);
      const firstBody = first.body as MasterBody;

      const second = await post('/masters', caller.accessToken).send({
        displayName: 'Usta Anar',
      });

      expect(second.status).toBe(200);
      expect((second.body as MasterBody).id).toBe(firstBody.id);
      expect(await masterRowCount(caller.userId)).toBe(1);
    });

    it('grants the master role, so a route gated on it now succeeds — even with a token minted before the profile existed', async () => {
      const caller = await signIn();

      // Not yet a master: the role-gated route refuses this exact token.
      const before = await get('/masters/me', caller.accessToken);
      expect(before.status).toBe(403);

      await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });

      // The same token, unchanged, now succeeds — roles are re-read from
      // `user_roles` on every request rather than cached in the token claim
      // minted at sign-in.
      const after = await get('/masters/me', caller.accessToken);
      expect(after.status).toBe(200);
    });
  });

  describe('GET /masters/me', () => {
    it('requires authentication', async () => {
      const res = await get('/masters/me');
      expect(res.status).toBe(401);
    });

    it('answers 403 for an authenticated caller who never created a master profile', async () => {
      // `RolesGuard` runs before `MastersService` ever looks for a row: a
      // caller who holds no `master` role is refused as "not yours to do",
      // not "not found" — that distinction belongs to `GET /masters/:id`,
      // which resolves the row first.
      const caller = await signIn();

      const res = await get('/masters/me', caller.accessToken);

      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it("returns the caller's own profile", async () => {
      const caller = await signInAsMaster();

      const res = await get('/masters/me', caller.accessToken);

      expect(res.status).toBe(200);
      expect((res.body as MasterBody).displayName).toBe('Usta Anar');
    });
  });

  describe('PATCH /masters/me', () => {
    it('requires authentication', async () => {
      const res = await patch('/masters/me');
      expect(res.status).toBe(401);
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signInAsMaster();

      const res = await patch('/masters/me', caller.accessToken).send({ extra: 'not allowed' });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an empty body — at least one field is required', async () => {
      const caller = await signInAsMaster();

      const res = await patch('/masters/me', caller.accessToken).send({});

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('updates displayName and persists it', async () => {
      const caller = await signInAsMaster();

      const res = await patch('/masters/me', caller.accessToken).send({
        displayName: 'Usta Anar Yeni',
      });

      expect(res.status).toBe(200);
      expect((res.body as MasterBody).displayName).toBe('Usta Anar Yeni');

      const reread = await get('/masters/me', caller.accessToken);
      expect((reread.body as MasterBody).displayName).toBe('Usta Anar Yeni');
    });

    it('clears the bio when the client sends an explicit null', async () => {
      // Omitting the field and sending `null` are different requests: the
      // first says "leave it alone", the second says "remove it".
      const caller = await signInAsMaster();
      await patch('/masters/me', caller.accessToken).send({ bio: 'Təcrübəli santexnik' });

      const res = await patch('/masters/me', caller.accessToken).send({ bio: null });

      expect(res.status).toBe(200);
      expect((res.body as MasterBody).bio).toBeNull();

      const reread = await get('/masters/me', caller.accessToken);
      expect((reread.body as MasterBody).bio).toBeNull();
    });
  });

  describe('DELETE /masters/me', () => {
    it('requires authentication', async () => {
      const res = await del('/masters/me');
      expect(res.status).toBe(401);
    });

    it(
      'answers 204, makes the profile unreachable by GET /masters/me afterwards, and lets a ' +
        'later POST revive it with the same id',
      async () => {
        // The row is soft-deleted, not dropped — the same pattern
        // `customers` uses: a master who deletes their profile and later
        // signs up again is the same master, not a stranger who happens to
        // hold the same phone number, and a `rejected` master cannot launder
        // the decision by deleting and re-registering.
        const caller = await signInAsMaster();
        const created = await get('/masters/me', caller.accessToken);
        const originalId = (created.body as MasterBody).id;

        const res = await del('/masters/me', caller.accessToken);
        expect(res.status).toBe(204);
        expect(res.text).toBe('');

        expect((await get('/masters/me', caller.accessToken)).status).toBe(404);

        const revived = await post('/masters', caller.accessToken).send({
          displayName: 'Usta Anar Yenidən',
        });

        expect(revived.status).toBe(200);
        const revivedBody = revived.body as MasterBody;
        expect(revivedBody.id).toBe(originalId);
        expect(await masterRowCount(caller.userId)).toBe(1);
      },
    );

    /**
     * The reason the revive does not reset `verification_status`, stated as a
     * test because it is the half that matters.
     *
     * If a revived profile came back `pending_verification`, deleting and
     * re-registering would be a one-request way for a rejected master to
     * re-enter the review queue with a clean record — and for a suspended one
     * to shed the suspension. The verdict belongs to the account, not to the
     * row, and it survives the round trip.
     */
    it('does not clear a rejection by deleting and registering again', async () => {
      const caller = await signInAsMaster();
      await pool.query(`update masters set verification_status = 'rejected' where user_id = $1`, [
        caller.userId,
      ]);

      expect((await del('/masters/me', caller.accessToken)).status).toBe(204);
      const revived = await post('/masters', caller.accessToken).send({ displayName: 'Anar' });

      expect(revived.status).toBe(200);
      expect((revived.body as MasterBody).verificationStatus).toBe('rejected');
    });
  });

  describe('GET /masters/:id', () => {
    it('requires authentication', async () => {
      const res = await get(`/masters/${unknownUuid()}`);
      expect(res.status).toBe(401);
    });

    it('returns the same body as GET /masters/me for the caller’s own id', async () => {
      const caller = await signInAsMaster();
      const own = await get('/masters/me', caller.accessToken);
      const ownId = (own.body as MasterBody).id;

      const byId = await get(`/masters/${ownId}`, caller.accessToken);

      expect(byId.status).toBe(200);
      expect(byId.body).toEqual(own.body);
    });

    it(
      'answers 404 — not 403 — for another master’s profile, with a body byte-identical to a ' +
        'genuinely unknown id',
      async () => {
        // The whole control: a 403 here would confirm the id belongs to
        // *someone*, turning the endpoint into an oracle a stranger could
        // walk sequential or guessed ids against to enumerate real masters.
        // A 404 that differs in any byte from the 404 for an id nobody ever
        // used is the same leak in a smaller disguise, which is why the
        // comparison is on the full envelope (minus the per-request
        // `requestId`), not just the status code.
        const owner = await signInAsMaster();
        const ownerProfile = await get('/masters/me', owner.accessToken);
        const ownerId = (ownerProfile.body as MasterBody).id;

        const stranger = await signInAsMaster();

        const notYours = await get(`/masters/${ownerId}`, stranger.accessToken);
        const neverExisted = await get(`/masters/${unknownUuid()}`, stranger.accessToken);

        expect(notYours.status).toBe(404);
        expect(neverExisted.status).toBe(404);
        expect(envelopeWithoutRequestId(notYours.body)).toEqual(
          envelopeWithoutRequestId(neverExisted.body),
        );
      },
    );
  });

  describe('offered services', () => {
    describe('POST /masters/me/services', () => {
      it('requires authentication', async () => {
        const res = await post('/masters/me/services').send({ serviceId: unknownUuid() });
        expect(res.status).toBe(401);
      });

      it('adds a fixed-price service with a priceMinor, which then appears in the list', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        expect(res.status).toBe(201);
        const body = res.body as MasterServiceBody;
        expect(body.serviceId).toBe(serviceId);
        expect(body.priceMinor).toBe(2000);
        expect(body.isActive).toBe(true);

        const list = (await get('/masters/me/services', caller.accessToken))
          .body as MasterServiceBody[];
        expect(list.map((item) => item.serviceId)).toContain(serviceId);
      });

      it('rejects adding the same service a second time with 409 CONFLICT', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2500,
        });

        expect(res.status).toBe(409);
        expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
      });

      it('answers 404 for a service id that does not exist in the catalogue', async () => {
        const caller = await signInAsMaster();

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId: unknownUuid(),
        });

        expect(res.status).toBe(404);
        expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      });

      it('rejects an inactive catalogue service with 409 CONFLICT, not 404', async () => {
        // The catalogue is public (ADR-0020), so there is no existence to
        // protect here — "this service is retired" is a different problem
        // from "no such service".
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed', isActive: false });

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        expect(res.status).toBe(409);
        expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
      });

      it('rejects a fixed-price service with no priceMinor, naming the pricing kind', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });

        const res = await post('/masters/me/services', caller.accessToken).send({ serviceId });

        expect(res.status).toBe(422);
        const body = res.body as ErrorEnvelope;
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(body.error.details?.pricingKind).toBe('fixed');
      });

      it('rejects an inspection-priced service that carries a priceMinor, naming the pricing kind', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'inspection' });

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        expect(res.status).toBe(422);
        const body = res.body as ErrorEnvelope;
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(body.error.details?.pricingKind).toBe('inspection');
      });

      it('adds an inspection-priced service with no price, and priceMinor comes back null', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'inspection' });

        const res = await post('/masters/me/services', caller.accessToken).send({ serviceId });

        expect(res.status).toBe(201);
        expect((res.body as MasterServiceBody).priceMinor).toBeNull();
      });

      it('rejects a priceMinor of zero and a negative priceMinor', async () => {
        const caller = await signInAsMaster();
        const zeroServiceId = await insertCatalogueService({ pricingKind: 'fixed' });
        const negativeServiceId = await insertCatalogueService({ pricingKind: 'fixed' });

        const zero = await post('/masters/me/services', caller.accessToken).send({
          serviceId: zeroServiceId,
          priceMinor: 0,
        });
        const negative = await post('/masters/me/services', caller.accessToken).send({
          serviceId: negativeServiceId,
          priceMinor: -500,
        });

        for (const res of [zero, negative]) {
          expect(res.status).toBe(422);
          expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
        }
      });

      it('answers 404 for a master whose profile has been soft-deleted', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await del('/masters/me', caller.accessToken);

        const res = await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        expect(res.status).toBe(404);
        expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      });
    });

    describe('PATCH /masters/me/services/:serviceId', () => {
      it('requires authentication', async () => {
        const res = await patch(`/masters/me/services/${unknownUuid()}`).send({ priceMinor: 100 });
        expect(res.status).toBe(401);
      });

      it('changes the price and persists it', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const res = await patch(`/masters/me/services/${serviceId}`, caller.accessToken).send({
          priceMinor: 3000,
        });

        expect(res.status).toBe(200);
        expect((res.body as MasterServiceBody).priceMinor).toBe(3000);

        const list = (await get('/masters/me/services', caller.accessToken))
          .body as MasterServiceBody[];
        expect(list.find((item) => item.serviceId === serviceId)?.priceMinor).toBe(3000);
      });

      it('rejects sending priceMinor: null for a fixed-price service — the resulting price would be missing', async () => {
        // The pricing-shape rule is checked against the row a write would
        // *result in*, not the patch alone: a fixed service that already has
        // a price must not be strippable down to no price by a PATCH that
        // only ever mentions `priceMinor`.
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const res = await patch(`/masters/me/services/${serviceId}`, caller.accessToken).send({
          priceMinor: null,
        });

        expect(res.status).toBe(422);
        const body = res.body as ErrorEnvelope;
        expect(body.error.code).toBe('VALIDATION_FAILED');
        expect(body.error.details?.pricingKind).toBe('fixed');
      });

      it('lets { isActive: false } alone succeed for a fixed-price service that already has a price', async () => {
        // The mirror image of the previous test: the check runs on the
        // *resulting* price, which is unchanged here (the patch never
        // mentions it), so a PATCH that only pauses the offer must not be
        // rejected as if it removed the price.
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const res = await patch(`/masters/me/services/${serviceId}`, caller.accessToken).send({
          isActive: false,
        });

        expect(res.status).toBe(200);
        const body = res.body as MasterServiceBody;
        expect(body.isActive).toBe(false);
        expect(body.priceMinor).toBe(2000);
      });

      it('answers 404 for a service the caller does not offer', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });

        const res = await patch(`/masters/me/services/${serviceId}`, caller.accessToken).send({
          priceMinor: 3000,
        });

        expect(res.status).toBe(404);
        expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      });

      it('rejects an empty body — at least one field is required', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const res = await patch(`/masters/me/services/${serviceId}`, caller.accessToken).send({});

        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      });
    });

    describe('DELETE /masters/me/services/:serviceId', () => {
      it('requires authentication', async () => {
        const res = await del(`/masters/me/services/${unknownUuid()}`);
        expect(res.status).toBe(401);
      });

      it('answers 204, then 404 on a second delete of the same offer', async () => {
        const caller = await signInAsMaster();
        const serviceId = await insertCatalogueService({ pricingKind: 'fixed' });
        await post('/masters/me/services', caller.accessToken).send({
          serviceId,
          priceMinor: 2000,
        });

        const first = await del(`/masters/me/services/${serviceId}`, caller.accessToken);
        expect(first.status).toBe(204);
        expect(first.text).toBe('');

        const list = (await get('/masters/me/services', caller.accessToken))
          .body as MasterServiceBody[];
        expect(list.map((item) => item.serviceId)).not.toContain(serviceId);

        const second = await del(`/masters/me/services/${serviceId}`, caller.accessToken);
        expect(second.status).toBe(404);
        expect((second.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
      });
    });
  });
});
