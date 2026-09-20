import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AcceptedOffer, MasterOffer } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { runSeed } from '../src/infra/database/seed';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The master's offer feed, decline and accept over real HTTP, through the real
 * `AppModule` graph (issue #101).
 *
 * **The test that matters most is the concurrent accept**, and it is the
 * reason this suite exists at this layer rather than as unit tests against a
 * mocked repository. ADR-0009: "concurrent accept correctness is now the
 * single most important invariant in the backend", and "this must be tested
 * with genuinely parallel requests — sequential calls do not exercise the race
 * the guard exists to prevent." A read-then-write implementation passes every
 * sequential test in this file and fails the parallel one, which is exactly
 * what makes the parallel one worth its runtime. It is repeated across several
 * orders, because one green run of a race is luck rather than evidence.
 *
 * The rest of the suite is the two rules that are easy to lose and invisible
 * in review once lost: the offer card carries **no address, no customer name
 * and no phone number** — asserted against the serialized response body rather
 * than against the intent — and the whole eligibility predicate is
 * re-evaluated at the instant of the accept, one test per term, each revoking
 * exactly one thing between the offer and the tap.
 *
 * **Offers are seeded with SQL, not produced by a broadcast.** The dispatch
 * engine that writes them is issue #103, developed alongside this one; what
 * this file owns is what a master can do with a row that already exists.
 *
 * `PRESENCE_*`, `DISPATCH_MAX_POSITION_AGE_SECONDS` and
 * `MAX_COMMISSION_DEBT_MINOR` are pinned before the app boots — `ConfigModule`
 * reads `process.env` exactly once, at instantiation.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

/** The floor `env.schema.ts` allows, so presence expiry is quick to arrange. */
const PRESENCE_TTL_SECONDS = 30;
const PRESENCE_HEARTBEAT_SECONDS = 10;

/** The freshness bound, at the floor `env.schema.ts` allows. Not the presence TTL (ADR-0026). */
const MAX_POSITION_AGE_SECONDS = 120;

/** The debt ceiling this suite asserts the boundary of, rather than inheriting. */
const MAX_COMMISSION_DEBT_MINOR = 5000;

/** Baku. Every seeded order's address, and the centre of every radius check. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

/** The radius every seeded offer round used, unless a test says otherwise. */
const ROUND_RADIUS_M = 3000;

/** How far from the job a seeded master stands, unless a test says otherwise. */
const DEFAULT_DISTANCE_M = 1200;

/**
 * Three prices that cannot be confused for one another: the catalogue's own
 * reference, the winner's, and a rival's. The freeze assertion is only worth
 * anything if the right number is distinguishable from every plausible wrong
 * one.
 */
const MASTER_PRICE_MINOR = 6700;
const RIVAL_PRICE_MINOR = 9100;

const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

/** A minimal object the confirm step's magic-byte sniff accepts as a JPEG. */
function jpegBytes(size = 16): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly addressId: string;
  readonly customerId: string;
  readonly customerToken: string;
}

interface MasterOptions {
  readonly priceMinor?: number | null;
  readonly serviceId?: string;
  readonly distanceM?: number;
  /** How long ago the master's only position was reported. */
  readonly locationAgeSeconds?: number;
}

interface OfferOptions {
  readonly status?: 'offered' | 'declined' | 'expired' | 'accepted' | 'lost';
  readonly expiresInSeconds?: number;
  readonly distanceM?: number;
  readonly radiusM?: number;
  readonly round?: number;
}

describe('the master offer feed, decline and accept over HTTP (issue #101)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let storage: StubStorageProvider;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let serviceId: string;
  let inspectionServiceId: string;
  let catalogueBasePriceMinor: number;
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
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

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    expect(tokens.verifyAccessToken(pair.accessToken).sub).toBe(created.user.id);
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  /**
   * A master who is eligible on every term: active, available, debt-free,
   * offering the service at their own price, standing `distanceM` metres from
   * the job with a fresh position and a live heartbeat.
   *
   * The profile goes through `POST /masters` because that is what grants the
   * `master` role; everything the endpoints refuse to set — verification,
   * availability, debt — is written with SQL, for the reason
   * `nearby-masters.integration.test.ts` gives: several of these tests need
   * precisely the master the endpoints exist to refuse.
   */
  async function seedMaster(options: MasterOptions = {}): Promise<SeededMaster> {
    const {
      priceMinor = MASTER_PRICE_MINOR,
      serviceId: offeredServiceId = serviceId,
      distanceM = DEFAULT_DISTANCE_M,
      locationAgeSeconds = 0,
    } = options;

    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters
          set verification_status = 'active', is_available = true, commission_debt_minor = 0
        where id = $1`,
      [masterId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, $3, true)`,
      [masterId, offeredServiceId, priceMinor],
    );
    await recordPosition(masterId, distanceM, locationAgeSeconds);
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, userId: caller.userId, accessToken: caller.accessToken };
  }

  /**
   * A position `distanceM` metres due east of the job, `ageSeconds` ago.
   *
   * `ST_Project` rather than arithmetic on degrees, for the reason
   * `nearby-masters.integration.test.ts` states: the radius term is exactly
   * what is under test, so the fixture may not assume a metres-per-degree
   * factor the query is being tested for.
   */
  async function recordPosition(
    masterId: string,
    distanceM: number,
    ageSeconds = 0,
  ): Promise<void> {
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values (
         $1, $2,
         ST_Project(
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
           $5::double precision,
           radians(90)
         )::geometry,
         now() - make_interval(secs => $6::int)
       )`,
      [
        randomUUID(),
        masterId,
        SEARCH_POINT.longitude,
        SEARCH_POINT.latitude,
        distanceM,
        ageSeconds,
      ],
    );
  }

  /** A real customer, a real address at the job site, and a real `SEARCHING` order. */
  async function seedOrder(orderServiceId = serviceId): Promise<SeededOrder> {
    const caller = await signIn();
    const profile = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    const addressId = (address.body as { id: string }).id;

    const order = await post('/orders', caller.accessToken).send({
      serviceId: orderServiceId,
      addressId,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    return {
      orderId: (order.body as { id: string }).id,
      addressId,
      customerId: (profile.body as { id: string }).id,
      customerToken: caller.accessToken,
    };
  }

  /** One `order_offers` row — what the dispatch engine (issue #103) will write. */
  async function seedOffer(
    orderId: string,
    masterId: string,
    options: OfferOptions = {},
  ): Promise<string> {
    const {
      status = 'offered',
      expiresInSeconds = 300,
      distanceM = DEFAULT_DISTANCE_M,
      radiusM = ROUND_RADIUS_M,
      round = 1,
    } = options;

    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at, responded_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8::int), $9)`,
      [
        offerId,
        orderId,
        masterId,
        round,
        radiusM,
        distanceM,
        status,
        expiresInSeconds,
        // `order_offers_response_consistent` demands a response time for
        // exactly the three statuses that carry one.
        ['declined', 'accepted', 'lost'].includes(status) ? new Date() : null,
      ],
    );
    return offerId;
  }

  /**
   * An attached problem photo, through the **real** upload path — presign,
   * the client's PUT (stood in for by the stub's `putObject`, as
   * `order-photos.e2e.test.ts` does), confirm, attach.
   *
   * Deliberately not an `insert ... values` with a hand-written
   * `storage_key`, which is what this fixture used to be. The offer card's
   * photo URLs are presigned **from that key**, so a fixture that invents its
   * own key tests the fixture's key shape rather than the server's — and the
   * assertion that the card leaks no customer id would pass with
   * `buildPhotoKey` putting the customer id straight into every URL. Going
   * through the endpoints means the key on the card is the one production
   * mints, and that assertion fails the moment it stops being opaque.
   */
  async function attachPhoto(order: SeededOrder): Promise<void> {
    const upload = await post('/orders/photos/presign', order.customerToken).send({
      contentType: 'image/jpeg',
    });
    expect(upload.status).toBe(201);
    const { photoId } = upload.body as { photoId: string };

    const { rows } = await pool.query<{ storage_key: string }>(
      'select storage_key from order_photos where id = $1',
      [photoId],
    );
    const storageKey = rows[0]?.storage_key;
    if (storageKey === undefined) {
      throw new Error('the presign should have written an order_photos row');
    }
    storage.putObject(storageKey, jpegBytes());

    const confirmed = await post(`/orders/photos/${photoId}/confirm`, order.customerToken);
    expect(confirmed.status).toBe(201);

    const attached = await post(`/orders/${order.orderId}/photos`, order.customerToken).send({
      photoId,
    });
    expect(attached.status).toBe(201);
  }

  async function offerStatus(offerId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from order_offers where id = $1',
      [offerId],
    );
    return rows[0]?.status ?? 'missing';
  }

  async function orderRow(orderId: string): Promise<{
    status: string;
    master_id: string | null;
    price_minor: string | null;
    accepted_at: Date | null;
  }> {
    const { rows } = await pool.query<{
      status: string;
      master_id: string | null;
      price_minor: string | null;
      accepted_at: Date | null;
    }>('select status, master_id, price_minor, accepted_at from orders where id = $1', [orderId]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('the order should exist');
    }
    return row;
  }

  function errorCode(body: unknown): string {
    return (body as ErrorEnvelope).error.code;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    // A key space of this file's own: the per-IP half of every policy is
    // shared by every test process talking to the same Redis from the same
    // address (see `orders.e2e.test.ts`).
    set('RATE_LIMIT_KEY_SECRET', `master-offers-e2e-${randomUUID()}`);
    set('PRESENCE_TTL_SECONDS', String(PRESENCE_TTL_SECONDS));
    set('PRESENCE_HEARTBEAT_SECONDS', String(PRESENCE_HEARTBEAT_SECONDS));
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', String(MAX_POSITION_AGE_SECONDS));
    set('MAX_COMMISSION_DEBT_MINOR', String(MAX_COMMISSION_DEBT_MINOR));
    // This suite is about offers, not about the budgets. Both limits have
    // their own subject elsewhere; here they are only an obstacle.
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_IP_HOUR', '9000');
    // `attachPhoto` drives the real presign/confirm path, which spends the
    // `document-upload` budget; this suite is not the place that budget is
    // under test.
    set('UPLOAD_PRESIGN_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('UPLOAD_PRESIGN_RATE_LIMIT_PER_IP_HOUR', '9000');
    /**
     * **This suite owns `order_offers` by hand, so the live dispatch engine is
     * configured to reach nobody here.**
     *
     * `seedOffer` builds rows in states the engine would not conveniently
     * produce — expired, declined, lost, a rival's `accepted` — and several
     * tests assert on the exact set of rows an order carries. The engine
     * (issue #103) broadcasts into the same table the moment `POST /orders`
     * returns, to every eligible master in this database: that both collides
     * with `seedOffer`'s insert on `order_offers_order_master_unique` and adds
     * rows no assertion here accounts for, since every master this file seeds
     * stands `DEFAULT_DISTANCE_M` from the same job site.
     *
     * A one-metre **initial** radius reaches none of them, which isolates this
     * subject through the engine's own configuration rather than by stubbing
     * it out — the wave still runs, and still writes nothing. A step equal to
     * the timeout makes that single wave the whole plan, so the radius never
     * widens off the initial value (`dispatchRadiusForRound`) and no give-up
     * tick transitions an order out from under a test.
     *
     * **`DISPATCH_MAX_RADIUS_M` is deliberately left alone.** It is not only
     * dispatch's ceiling: `NearbyMastersRepository` clamps the accept path's
     * radius against it too, so lowering it here would refuse every master
     * this file invites at `ROUND_RADIUS_M` and turn the accept tests into
     * `MASTER_NOT_ELIGIBLE_FOR_OFFER`.
     *
     * What the engine does when it *does* reach a master is
     * `dispatch.e2e.test.ts`'s subject, not this file's.
     */
    set('DISPATCH_INITIAL_RADIUS_M', '1');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    /**
     * **Bind the server once, here, rather than letting supertest do it per
     * request.**
     *
     * `request(server)` starts the server itself when it is not already
     * listening — and this suite is the only one in the repository that fires
     * six requests at a single instant, so six `Test` objects reach that check
     * together and race to bind the same socket. The symptom is an
     * `ECONNRESET` in the concurrency test under a loaded machine and a green
     * run on an idle one, which is the worst possible failure mode for the
     * test that exists to prove a race is handled: it makes the *harness* look
     * like the invariant.
     */
    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    tokens = app.get(TokenService);
    presence = app.get(MasterPresenceService);
    storage = app.get<StubStorageProvider>(STORAGE_PROVIDER);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const fixed = await pool.query<{ id: string; base_price_minor: string }>(
      `select id, base_price_minor from services
        where is_active and pricing_kind = 'fixed' order by id limit 1`,
    );
    const first = fixed.rows[0];
    if (first === undefined) {
      throw new Error('the seed should have provided an active fixed-price service');
    }
    serviceId = first.id;
    catalogueBasePriceMinor = Number(first.base_price_minor);

    const inspection = await pool.query<{ id: string }>(
      `select id from services where is_active and pricing_kind = 'inspection' order by id limit 1`,
    );
    const inspectionRow = inspection.rows[0];
    if (inspectionRow === undefined) {
      throw new Error('the seed should have provided an inspection-priced service');
    }
    inspectionServiceId = inspectionRow.id;
  }, 120_000);

  afterAll(async () => {
    for (const masterId of seededMasterIds) {
      await presence.clear(masterId);
    }
    await pool.end();
    await app.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('the feed', () => {
    it('shows a live offer with exactly the five things on the card, and nothing else', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      const res = await get('/masters/me/offers', master.accessToken);

      expect(res.status).toBe(200);
      const offers = res.body as MasterOffer[];
      expect(offers).toHaveLength(1);

      const [offer] = offers;
      expect(offer).toBeDefined();
      expect(Object.keys(offer as object).sort()).toEqual([
        'description',
        'distanceBand',
        'expiresAt',
        'id',
        'photos',
        'priceMinor',
        'serviceId',
      ]);
      expect(offer).toMatchObject({
        id: offerId,
        serviceId,
        description: DESCRIPTION,
        distanceBand: 'from_1_to_2km',
        priceMinor: MASTER_PRICE_MINOR,
      });
    });

    /**
     * Asserted against the **serialized body**, not against the shape the
     * projection intended. A field added to the card later, or an object
     * accidentally spread into it, would put a home address on a broadcast
     * that reaches twenty strangers — and would pass a test written against
     * `Object.keys` alone if the value were nested.
     *
     * **The photo is attached on purpose**, and it is what makes
     * `not.toContain(order.customerId)` mean anything: a card with an empty
     * `photos` array cannot leak a customer id however the server builds one.
     * The presigned read URL carries the object key verbatim, so this is the
     * assertion that holds `buildPhotoKey` opaque — an identifier stable
     * across every order that customer ever places, on a card that reaches up
     * to `DISPATCH_MAX_MASTERS_PER_BROADCAST` masters who mostly never take
     * the job.
     */
    it('carries no address, no customer name, no phone number and no customer id — photos included', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      await attachPhoto(order);
      await seedOffer(order.orderId, master.masterId);

      const res = await get('/masters/me/offers', master.accessToken);
      const body = JSON.stringify(res.body);

      // Without this the rest of the assertions are about an empty array.
      expect((res.body as MasterOffer[])[0]?.photos).toHaveLength(1);
      expect(body).not.toContain('Nizami');
      expect(body).not.toContain('Müştəri');
      expect(body).not.toContain('+994');
      expect(body).not.toContain(order.addressId);
      expect(body).not.toContain(order.customerId);
      expect(body).not.toContain(order.orderId);
      // The exact distance is what a band exists to withhold; three masters
      // comparing metres against their own positions locate the door.
      expect(body).not.toContain(String(DEFAULT_DISTANCE_M));
      expect(body).not.toContain(String(SEARCH_POINT.latitude));
      expect(body).not.toContain(String(SEARCH_POINT.longitude));
    });

    it('carries the problem photos as short-lived read URLs', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      await attachPhoto(order);
      await seedOffer(order.orderId, master.masterId);

      const res = await get('/masters/me/offers', master.accessToken);
      const [offer] = res.body as MasterOffer[];

      expect(offer?.photos).toHaveLength(1);
      expect(offer?.photos[0]?.url).toContain('stub://download/');
      expect(offer?.photos[0]?.url).not.toContain(order.customerId);
      expect(Date.parse(offer?.photos[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    });

    /**
     * The photos for the whole feed come back in **one** batched read, grouped
     * in memory, rather than a query per card — which is what the feed used to
     * do, on the one endpoint a master's app polls continuously (CLAUDE.md
     * §12). Grouping is where a batched read goes wrong, and it goes wrong
     * invisibly: every card still has *a* photo. So this asserts the counts
     * differ per order and that an order with none gets none, which no
     * misgrouping satisfies by accident.
     */
    it('puts each order’s own photos on its own card, and none on an order with none', async () => {
      const master = await seedMaster();
      const two = await seedOrder();
      const one = await seedOrder();
      const none = await seedOrder();

      await attachPhoto(two);
      await attachPhoto(two);
      await attachPhoto(one);

      const offers = [
        { orderId: two.orderId, id: await seedOffer(two.orderId, master.masterId) },
        { orderId: one.orderId, id: await seedOffer(one.orderId, master.masterId) },
        { orderId: none.orderId, id: await seedOffer(none.orderId, master.masterId) },
      ];

      const res = await get('/masters/me/offers', master.accessToken);
      expect(res.status).toBe(200);
      const byOfferId = new Map(
        (res.body as MasterOffer[]).map((offer) => [offer.id, offer.photos]),
      );

      expect(byOfferId.get(offers[0]?.id ?? '')).toHaveLength(2);
      expect(byOfferId.get(offers[1]?.id ?? '')).toHaveLength(1);
      expect(byOfferId.get(offers[2]?.id ?? '')).toEqual([]);

      // Every URL is distinct — a grouping bug that handed one order's photos
      // to every card would repeat them.
      const urls = [...byOfferId.values()].flat().map((photo) => photo.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('shows this master their own price, not the catalogue reference', async () => {
      const master = await seedMaster({ priceMinor: MASTER_PRICE_MINOR });
      const order = await seedOrder();
      await seedOffer(order.orderId, master.masterId);

      const [offer] = (await get('/masters/me/offers', master.accessToken)).body as MasterOffer[];
      expect(offer?.priceMinor).toBe(MASTER_PRICE_MINOR);
      expect(offer?.priceMinor).not.toBe(catalogueBasePriceMinor);
    });

    it.each(['declined', 'expired', 'lost', 'accepted'] as const)(
      'leaves a %s offer out of the feed',
      async (status) => {
        const master = await seedMaster();
        const order = await seedOrder();
        await seedOffer(order.orderId, master.masterId, { status });

        const res = await get('/masters/me/offers', master.accessToken);
        expect(res.body).toEqual([]);
      },
    );

    it('leaves out an offer whose window has run out, whatever the row still says', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      await seedOffer(order.orderId, master.masterId, { expiresInSeconds: -60 });

      expect((await get('/masters/me/offers', master.accessToken)).body).toEqual([]);
    });

    it('leaves out an offer whose order has stopped searching', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      await seedOffer(order.orderId, master.masterId);
      await pool.query(`update orders set status = 'CANCELLED' where id = $1`, [order.orderId]);

      expect((await get('/masters/me/offers', master.accessToken)).body).toEqual([]);
    });

    it('shows a master only their own offers', async () => {
      const mine = await seedMaster();
      const stranger = await seedMaster();
      const order = await seedOrder();
      await seedOffer(order.orderId, stranger.masterId);

      expect((await get('/masters/me/offers', mine.accessToken)).body).toEqual([]);
    });

    it('requires authentication', async () => {
      expect((await get('/masters/me/offers')).status).toBe(401);
    });

    it('answers 404 for a caller with no master profile', async () => {
      const caller = await signIn();
      const res = await get('/masters/me/offers', caller.accessToken);
      // 403 from the role guard, or 404 from the missing profile — either way
      // the caller learns nothing about anybody's offers.
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('decline', () => {
    it('declines, and the offer leaves the feed', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      const res = await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ offerId, status: 'declined' });
      expect(await offerStatus(offerId)).toBe('declined');
      expect((await get('/masters/me/offers', master.accessToken)).body).toEqual([]);
    });

    /**
     * ADR-0009 makes a decline permanent: "a master who declines an offer is
     * never shown it again, in any later round". A widening round re-offers by
     * updating rows that are still `offered` — the only thing
     * `order_offers_order_master_unique` leaves it able to do — so this
     * simulates exactly that and asserts the declined row is passed over.
     */
    it('stays declined across a re-broadcast, and never returns to the feed', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send({});

      const rebroadcast = await pool.query(
        `update order_offers
            set round = round + 1,
                radius_m = 6000,
                expires_at = now() + make_interval(secs => 300)
          where order_id = $1 and status = 'offered'`,
        [order.orderId],
      );

      expect(rebroadcast.rowCount).toBe(0);
      expect(await offerStatus(offerId)).toBe('declined');
      expect((await get('/masters/me/offers', master.accessToken)).body).toEqual([]);
    });

    it('answers a second decline clearly rather than with a 500', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send({});
      const res = await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('OFFER_NO_LONGER_ACTIONABLE');
    });

    it.each(['expired', 'lost'] as const)(
      'answers a decline of a %s offer clearly rather than with a 500',
      async (status) => {
        const master = await seedMaster();
        const order = await seedOrder();
        const offerId = await seedOffer(order.orderId, master.masterId, { status });

        const res = await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send(
          {},
        );

        expect(res.status).toBe(409);
        expect(errorCode(res.body)).toBe('OFFER_NO_LONGER_ACTIONABLE');
      },
    );

    /**
     * The same 404, byte for byte, that an id naming nothing gets. A 403 would
     * confirm the offer exists — and an offer's existence says that a
     * particular master was near a particular job at a particular time.
     */
    it('cannot tell another master’s offer id from one that never existed', async () => {
      const mine = await seedMaster();
      const stranger = await seedMaster();
      const order = await seedOrder();
      const theirOfferId = await seedOffer(order.orderId, stranger.masterId);

      const theirs = await post(
        `/masters/me/offers/${theirOfferId}/decline`,
        mine.accessToken,
      ).send({});
      const nobodys = await post(
        `/masters/me/offers/${randomUUID()}/decline`,
        mine.accessToken,
      ).send({});

      expect(theirs.status).toBe(404);
      expect(nobodys.status).toBe(404);
      expect(theirs.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'NOT_FOUND', message: 'Not found.' }),
        }),
      );
      expect(nobodys.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'NOT_FOUND', message: 'Not found.' }),
        }),
      );
    });
  });

  describe('accept — the happy path and the freeze', () => {
    it('assigns the master, freezes their own price, and reveals the address', async () => {
      const master = await seedMaster({ priceMinor: MASTER_PRICE_MINOR });
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(200);
      const accepted = res.body as AcceptedOffer;
      expect(accepted).toMatchObject({
        offerId,
        orderId: order.orderId,
        serviceId,
        description: DESCRIPTION,
        priceMinor: MASTER_PRICE_MINOR,
      });
      expect(accepted.address).toMatchObject({
        id: order.addressId,
        formattedAddress: 'Nizami küçəsi 203',
      });

      const row = await orderRow(order.orderId);
      expect(row.status).toBe('ACCEPTED');
      expect(row.master_id).toBe(master.masterId);
      expect(Number(row.price_minor)).toBe(MASTER_PRICE_MINOR);
      expect(row.accepted_at).not.toBeNull();
    });

    it('freezes the winner’s own price, which is not the catalogue reference', async () => {
      const master = await seedMaster({ priceMinor: MASTER_PRICE_MINOR });
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      const row = await orderRow(order.orderId);
      expect(Number(row.price_minor)).toBe(MASTER_PRICE_MINOR);
      expect(Number(row.price_minor)).not.toBe(catalogueBasePriceMinor);
      expect(Number(row.price_minor)).not.toBe(RIVAL_PRICE_MINOR);
    });

    /**
     * **The freeze, against a rival who charges something else.**
     *
     * Every other freeze test seeds one master, and the concurrency test's six
     * all carry `MASTER_PRICE_MINOR` — so a subquery correlated on the *order*
     * rather than on the accepting master would satisfy all of them. Two
     * masters offered the same order at prices that cannot be confused, both
     * tapping accept, is the arrangement where a wrong correlation is
     * observable: the winner is whoever the `WHERE` clause picked, and the
     * price on the order has to be **that** master's, whichever one it was.
     *
     * Asserted without naming an expected winner, because the race has no
     * expected winner — that is the point of it.
     */
    it('freezes the price of whichever master won, not the rival’s', async () => {
      const cheaper = await seedMaster({ priceMinor: MASTER_PRICE_MINOR });
      const dearer = await seedMaster({ priceMinor: RIVAL_PRICE_MINOR });
      expect(MASTER_PRICE_MINOR).not.toBe(RIVAL_PRICE_MINOR);

      const order = await seedOrder();
      const offers = [
        { master: cheaper, offerId: await seedOffer(order.orderId, cheaper.masterId) },
        { master: dearer, offerId: await seedOffer(order.orderId, dearer.masterId) },
      ];

      const responses = await Promise.all(
        offers.map(async ({ master, offerId }) => ({
          master,
          res: await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({}),
        })),
      );

      const won = responses.filter(({ res }) => res.status === 200);
      expect(won).toHaveLength(1);
      const winner = won[0];
      expect(winner).toBeDefined();

      const expectedPrice =
        winner?.master.masterId === cheaper.masterId ? MASTER_PRICE_MINOR : RIVAL_PRICE_MINOR;
      const rivalPrice =
        winner?.master.masterId === cheaper.masterId ? RIVAL_PRICE_MINOR : MASTER_PRICE_MINOR;

      const row = await orderRow(order.orderId);
      expect(row.master_id).toBe(winner?.master.masterId);
      expect(Number(row.price_minor)).toBe(expectedPrice);
      expect(Number(row.price_minor)).not.toBe(rivalPrice);
      expect((winner?.res.body as AcceptedOffer).priceMinor).toBe(expectedPrice);
    });

    /**
     * ADR-0013 rule 5: "a master's later price edit never moves a frozen
     * price. The freeze is a copy, not a reference."
     */
    it('does not move the order’s price when the master edits their price afterwards', async () => {
      const master = await seedMaster({ priceMinor: MASTER_PRICE_MINOR });
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});
      await pool.query(
        'update master_services set price_minor = $1 where master_id = $2 and service_id = $3',
        [RIVAL_PRICE_MINOR, master.masterId, serviceId],
      );

      expect(Number((await orderRow(order.orderId)).price_minor)).toBe(MASTER_PRICE_MINOR);
    });

    /**
     * Null and zero mean different things, and ADR-0013 depends on the
     * difference: `orders_price_requires_master` and `orders_price_positive`
     * both permit a null price on an assigned order, and a zero would be a
     * free repair nobody decided on.
     */
    it('freezes null, not zero, for an inspection-priced service', async () => {
      const master = await seedMaster({
        priceMinor: null,
        serviceId: inspectionServiceId,
      });
      const order = await seedOrder(inspectionServiceId);
      const offerId = await seedOffer(order.orderId, master.masterId);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(200);
      expect((res.body as AcceptedOffer).priceMinor).toBeNull();
      expect((await orderRow(order.orderId)).price_minor).toBeNull();
    });

    it('writes SEARCHING → ACCEPTED to the audit trail, attributed to the master', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      const { rows } = await pool.query<{
        from_status: string;
        to_status: string;
        actor_kind: string;
        actor_user_id: string | null;
      }>(
        `select from_status, to_status, actor_kind, actor_user_id
           from order_status_history
          where order_id = $1 and to_status = 'ACCEPTED'`,
        [order.orderId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from_status: 'SEARCHING',
        to_status: 'ACCEPTED',
        actor_kind: 'master',
        actor_user_id: master.userId,
      });
    });

    it('marks the winner’s offer accepted and every other live offer lost', async () => {
      const winner = await seedMaster();
      const loser = await seedMaster();
      const declined = await seedMaster();
      const order = await seedOrder();

      const winning = await seedOffer(order.orderId, winner.masterId);
      const losing = await seedOffer(order.orderId, loser.masterId);
      const alreadyDeclined = await seedOffer(order.orderId, declined.masterId, {
        status: 'declined',
      });

      await post(`/masters/me/offers/${winning}/accept`, winner.accessToken).send({});

      expect(await offerStatus(winning)).toBe('accepted');
      expect(await offerStatus(losing)).toBe('lost');
      // A decline is a fact that happened; `lost` would overwrite it.
      expect(await offerStatus(alreadyDeclined)).toBe('declined');
    });
  });

  describe('accept — the address reveal', () => {
    it('is readable by the winner afterwards, and by nobody else', async () => {
      const winner = await seedMaster();
      const loser = await seedMaster();
      const order = await seedOrder();
      const winning = await seedOffer(order.orderId, winner.masterId);
      const losing = await seedOffer(order.orderId, loser.masterId);

      await post(`/masters/me/offers/${winning}/accept`, winner.accessToken).send({});

      const mine = await get(`/masters/me/offers/${winning}/address`, winner.accessToken);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ id: order.addressId });

      const theirs = await get(`/masters/me/offers/${losing}/address`, loser.accessToken);
      expect(theirs.status).toBe(404);

      const strangers = await get(`/masters/me/offers/${winning}/address`, loser.accessToken);
      expect(strangers.status).toBe(404);
    });

    it('is not readable before the accept', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      const res = await get(`/masters/me/offers/${offerId}/address`, master.accessToken);
      expect(res.status).toBe(404);
    });

    /**
     * A master who accepted and then fell off the order — a re-dispatch
     * (ADR-0015) clears `master_id` — keeps an `accepted` offer row. They must
     * not keep the customer's home address with it.
     */
    it('is taken back when the order leaves this master', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});
      await pool.query(
        `update orders set status = 'SEARCHING', master_id = null, price_minor = null,
                           accepted_at = null, redispatch_count = redispatch_count + 1
          where id = $1`,
        [order.orderId],
      );

      const res = await get(`/masters/me/offers/${offerId}/address`, master.accessToken);
      expect(res.status).toBe(404);
    });
  });

  /**
   * **The one that decides whether any of this is correct.**
   *
   * ADR-0009: several masters *will* tap accept in the same second, and
   * exactly one must win. Fired with `Promise.all` so every request is in
   * flight before any of them commits — the shape a broadcast actually
   * produces, and the shape a read-then-write implementation fails.
   *
   * Repeated over several independent orders, because one green run of a race
   * is luck. Six masters per order, so a bug that lets exactly two through is
   * as visible as one that lets all six through.
   */
  describe('accept — the race', () => {
    const MASTERS_PER_ORDER = 6;
    const ROUNDS = 5;

    it('produces exactly one winner and N−1 ORDER_ALREADY_TAKEN, every time', async () => {
      const masters = await Promise.all(
        Array.from({ length: MASTERS_PER_ORDER }, async () => seedMaster()),
      );

      for (let round = 0; round < ROUNDS; round += 1) {
        const order = await seedOrder();
        const offers = await Promise.all(
          masters.map(async (master) => ({
            master,
            offerId: await seedOffer(order.orderId, master.masterId),
          })),
        );

        const responses = await Promise.all(
          offers.map(async ({ master, offerId }) =>
            post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({}),
          ),
        );

        const winners = responses.filter((res) => res.status === 200);
        const losers = responses.filter((res) => res.status !== 200);

        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(MASTERS_PER_ORDER - 1);
        // Not one 500 among them. A generic failure here is the exact
        // outcome ADR-0009 calls a support ticket.
        for (const loser of losers) {
          expect(loser.status).toBe(409);
          expect(errorCode(loser.body)).toBe('ORDER_ALREADY_TAKEN');
        }

        const row = await orderRow(order.orderId);
        expect(row.status).toBe('ACCEPTED');
        expect(row.master_id).not.toBeNull();

        // Exactly one row claimed the order, and exactly one offer says so.
        const { rows } = await pool.query<{ status: string; count: string }>(
          'select status, count(*) as count from order_offers where order_id = $1 group by status',
          [order.orderId],
        );
        const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
        expect(byStatus['accepted']).toBe(1);
        expect(byStatus['lost']).toBe(MASTERS_PER_ORDER - 1);

        // One winner means one transition, however many requests raced.
        const history = await pool.query<{ count: string }>(
          `select count(*) as count from order_status_history
              where order_id = $1 and to_status = 'ACCEPTED'`,
          [order.orderId],
        );
        expect(Number(history.rows[0]?.count)).toBe(1);

        // Free the masters for the next round — one active order each.
        await pool.query(`update orders set status = 'COMPLETED' where id = $1`, [order.orderId]);
      }
    }, 180_000);
  });

  /**
   * One test per eligibility term, each revoking exactly one thing between the
   * offer and the tap. A single "happy path plus one big negative" suite would
   * pass with half the predicate deleted, because every refused master would
   * still be refused by whichever term survived.
   */
  describe('accept — eligibility re-evaluated at the instant of the accept', () => {
    async function offerTo(master: SeededMaster, options: OfferOptions = {}) {
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId, options);
      return { order, offerId };
    }

    it('refuses a master suspended between the offer and the accept', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [master.masterId],
      );

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      // `assertCanAcceptWork` answers first, and says which status — "you are
      // suspended" and "you are still waiting on review" are different screens.
      expect(errorCode(res.body)).toBe('CONFLICT');
    });

    it('refuses a master who went offline between the offer and the accept', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await pool.query('update masters set is_available = false where id = $1', [master.masterId]);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });

    /**
     * Stored intent and liveness are two independent facts (issue #40). A
     * master whose app died still reads `is_available`, and a forced-quit app
     * is not online.
     */
    it('refuses a master whose presence has lapsed', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await presence.clear(master.masterId);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });

    it('refuses a master who drove out of the round’s radius', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master, { radiusM: ROUND_RADIUS_M });
      // A newer position, well outside the radius the round used.
      await recordPosition(master.masterId, ROUND_RADIUS_M + 4000);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });

    /**
     * The one term nobody revokes — the clock does. A master whose app stopped
     * reporting has a position that ages past
     * `DISPATCH_MAX_POSITION_AGE_SECONDS` while the offer is still live, and
     * `master_locations` is append-only by trigger, so the fixture seeds the
     * old position rather than editing a fresh one into the past. The
     * predicate reads it the same way either way: the master's newest report
     * is outside the freshness window, so they are *missing* rather than "in
     * range at their last known point" (ADR-0026).
     */
    it('refuses a master whose position went stale', async () => {
      const master = await seedMaster({ locationAgeSeconds: MAX_POSITION_AGE_SECONDS + 60 });
      const { offerId } = await offerTo(master);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });

    it('refuses a master past the commission-debt ceiling', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await pool.query('update masters set commission_debt_minor = $2 where id = $1', [
        master.masterId,
        MAX_COMMISSION_DEBT_MINOR + 1,
      ]);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });

    it('accepts a master exactly at the commission-debt ceiling', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await pool.query('update masters set commission_debt_minor = $2 where id = $1', [
        master.masterId,
        MAX_COMMISSION_DEBT_MINOR,
      ]);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});
      expect(res.status).toBe(200);
    });

    /**
     * `masterEligibilityTerms`' first clause is `m.deleted_at is null`, and it
     * was the one term with nothing revoking it between the offer and the tap.
     *
     * The answer is **404, not 409**, and deliberately so: a soft-deleted
     * profile is invisible to `MastersService.getOwn`, so the request stops at
     * "you have no master profile" before the dispatch predicate is reached.
     * That is the honest answer — the caller asked to act as a master who no
     * longer exists — and it also means this test cannot be what covers the
     * SQL term. `nearby-masters.integration.test.ts` asserts that directly,
     * against `isEligible`; this asserts what a deleted master's tap actually
     * does, which is what a client would see.
     */
    it('refuses a master soft-deleted between the offer and the accept', async () => {
      const master = await seedMaster();
      const { order, offerId } = await offerTo(master);
      await pool.query('update masters set deleted_at = now() where id = $1', [master.masterId]);

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect([403, 404]).toContain(res.status);
      expect((await orderRow(order.orderId)).status).toBe('SEARCHING');
      expect(await offerStatus(offerId)).toBe('offered');
    });

    it('refuses a master who stopped offering the service', async () => {
      const master = await seedMaster();
      const { offerId } = await offerTo(master);
      await pool.query(
        'update master_services set is_active = false where master_id = $1 and service_id = $2',
        [master.masterId, serviceId],
      );

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_NOT_ELIGIBLE_FOR_OFFER');
    });
  });

  describe('accept — the states that refuse it', () => {
    it('refuses a master who already holds a live order', async () => {
      const master = await seedMaster();
      const first = await seedOrder();
      const second = await seedOrder();
      const firstOffer = await seedOffer(first.orderId, master.masterId);
      const secondOffer = await seedOffer(second.orderId, master.masterId);

      expect(
        (await post(`/masters/me/offers/${firstOffer}/accept`, master.accessToken).send({})).status,
      ).toBe(200);

      const res = await post(`/masters/me/offers/${secondOffer}/accept`, master.accessToken).send(
        {},
      );

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('MASTER_HAS_ACTIVE_ORDER');
      // The second order is untouched — the refusal is not a half-write.
      expect((await orderRow(second.orderId)).status).toBe('SEARCHING');
      expect(await offerStatus(secondOffer)).toBe('offered');
    });

    it('answers ORDER_ALREADY_TAKEN for an order another master has accepted', async () => {
      const winner = await seedMaster();
      const late = await seedMaster();
      const order = await seedOrder();
      const winning = await seedOffer(order.orderId, winner.masterId);
      const lateOffer = await seedOffer(order.orderId, late.masterId);

      await post(`/masters/me/offers/${winning}/accept`, winner.accessToken).send({});
      const res = await post(`/masters/me/offers/${lateOffer}/accept`, late.accessToken).send({});

      expect(res.status).toBe(409);
      // The same code a concurrent loser gets. A late tap and a lost race are
      // the same thing to the master holding the phone.
      expect(errorCode(res.body)).toBe('ORDER_ALREADY_TAKEN');
    });

    it.each(['CANCELLED', 'NO_MASTER_FOUND'] as const)(
      'refuses an accept against a %s order with a specific code',
      async (status) => {
        const master = await seedMaster();
        const order = await seedOrder();
        const offerId = await seedOffer(order.orderId, master.masterId);
        await pool.query('update orders set status = $2 where id = $1', [order.orderId, status]);

        const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

        expect(res.status).toBe(409);
        expect(errorCode(res.body)).toBe('ORDER_INVALID_TRANSITION');
        expect((await orderRow(order.orderId)).status).toBe(status);
      },
    );

    it('refuses an accept on an expired offer', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId, { expiresInSeconds: -60 });

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('OFFER_NO_LONGER_ACTIONABLE');
      expect((await orderRow(order.orderId)).status).toBe('SEARCHING');
    });

    it('refuses an accept on an offer this master already declined', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      await post(`/masters/me/offers/${offerId}/decline`, master.accessToken).send({});
      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('OFFER_NO_LONGER_ACTIONABLE');
    });

    it('tells a master whose offer was already lost that the job is gone', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId, { status: 'lost' });

      const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({});

      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('ORDER_ALREADY_TAKEN');
    });

    it('cannot tell another master’s offer id from one that never existed', async () => {
      const mine = await seedMaster();
      const stranger = await seedMaster();
      const order = await seedOrder();
      const theirOfferId = await seedOffer(order.orderId, stranger.masterId);

      const theirs = await post(`/masters/me/offers/${theirOfferId}/accept`, mine.accessToken).send(
        {},
      );
      const nobodys = await post(
        `/masters/me/offers/${randomUUID()}/accept`,
        mine.accessToken,
      ).send({});

      expect(theirs.status).toBe(404);
      expect(nobodys.status).toBe(404);
      expect((await orderRow(order.orderId)).status).toBe('SEARCHING');
    });

    it('requires authentication', async () => {
      const res = await post(`/masters/me/offers/${randomUUID()}/accept`).send({});
      expect(res.status).toBe(401);
    });

    /**
     * `priceMinor`, `status` and `masterId` are all the server's. A body
     * carrying any of them is refused rather than quietly ignored — the client
     * that sent it believed something, and it should be told it was wrong.
     */
    it('refuses a body that tries to name the price, the status or the master', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await seedOffer(order.orderId, master.masterId);

      for (const smuggled of [
        { priceMinor: 1 },
        { status: 'ACCEPTED' },
        { masterId: randomUUID() },
      ]) {
        const res = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
          smuggled,
        );
        expect(res.status).toBe(422);
      }

      expect((await orderRow(order.orderId)).status).toBe('SEARCHING');
    });

    it('refuses an offer id that is not a uuid', async () => {
      const master = await seedMaster();
      const res = await post('/masters/me/offers/not-a-uuid/accept', master.accessToken).send({});
      expect(res.status).toBe(422);
    });
  });
});
