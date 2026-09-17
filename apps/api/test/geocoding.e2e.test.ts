import { randomUUID } from 'node:crypto';

import { ConsoleLogger, Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import type {
  GeocodedPoint,
  GeocodingProvider,
  StructuredAddress,
} from '../src/infra/geo/geocoding.types';
import { GEOCODING_PROVIDER } from '../src/infra/geo/geocoding.types';
import { normaliseAddress } from '../src/infra/geo/normalise-address';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `/geocode/forward` and `/geocode/reverse` over real HTTP, through the real
 * `AppModule` graph — the same construction as `addresses.e2e.test.ts` and
 * `customer-profile.e2e.test.ts`.
 *
 * The **maps provider** is the one boundary this suite mocks
 * (`docs/engineering/testing-strategy.md` § Mocking: "the HTTP transport, the
 * SMS provider, the maps provider. Not internal modules"). Everything else —
 * routing, guards, validation, the Postgres cache — runs against the real
 * `AppModule` graph and a real, disposable Postgres database, via
 * `overrideProvider(GEOCODING_PROVIDER)`.
 *
 * What only this layer can prove: that both routes actually sit behind
 * authentication, that a repeated forward lookup hits the Postgres cache
 * rather than the provider, that the cache key is the *normalised* address
 * (so two spellings of one address are one row), that an expired row is
 * refreshed rather than trusted, that a provider failure never corrupts the
 * cache, and that a reverse lookup is never written to it at all. None of that
 * is visible from a unit test of a service against a mocked repository.
 *
 * **Why both routes are `POST`, not `GET`, even though neither one writes
 * anything:** an address and a coordinate are both PII
 * (`docs/engineering/security.md` — a home address, and "precise
 * coordinates"). A `GET` puts its parameters in the URL, and a URL is the
 * single most commonly logged string in an HTTP stack — access logs, reverse
 * proxies, CDN logs, browser history, the `Referer` header of whatever the
 * client navigates to next. A `POST` body is not immune to logging in
 * principle, but nothing in this stack logs a request body by default, and
 * every layer that *would* have to opt in, where a URL is logged by default
 * almost everywhere. The REST purity argument for `GET` on a read loses to
 * that.
 */

/** `users.phone_e164` is unique among live rows — see `addresses.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

let addressCounter = 0;

/** A fresh, never-before-used address string, so cache assertions never collide across tests. */
function uniqueAddress(base = 'Nizami küçəsi'): string {
  addressCounter += 1;
  return `${base} ${addressCounter}`;
}

/**
 * Two different spellings of the SAME address — different leading/trailing
 * whitespace and different case — carrying the same unique numeric suffix so
 * this pair never collides with another test's address. `normaliseAddress`
 * folds both down to one cache key; the test below asserts that fold actually
 * happens end-to-end, through HTTP and the real cache table, not merely at
 * the unit level `normalise-address.test.ts` covers.
 */
function addressSpellingPair(): [padded: string, plain: string] {
  addressCounter += 1;
  const n = addressCounter;
  return [`  28 May küç. ${n}  `, `28 may küç. ${n}`];
}

function defaultGeocodedPoint(overrides: Partial<GeocodedPoint> = {}): GeocodedPoint {
  return {
    latitude: 40.409264,
    longitude: 49.867092,
    placeId: 'ChIJ-default-forward-place',
    ...overrides,
  };
}

function defaultStructuredAddress(overrides: Partial<StructuredAddress> = {}): StructuredAddress {
  return {
    formattedAddress: 'Nizami küçəsi 10, Bakı, Azərbaycan',
    streetNumber: '10',
    street: 'Nizami küçəsi',
    district: 'Səbail',
    city: 'Bakı',
    postalCode: 'AZ1000',
    latitude: 40.409264,
    longitude: 49.867092,
    placeId: 'ChIJ-default-reverse-place',
    ...overrides,
  };
}

/**
 * A controllable double for {@link GeocodingProvider}, swapped in for the
 * whole file via `overrideProvider(GEOCODING_PROVIDER)` rather than rebuilt
 * per test — rebuilding the Nest graph and re-migrating a fresh database for
 * every `it()` here would make the suite minutes slower for no additional
 * coverage, since the wiring under test (DI, guards, validation, HTTP, the
 * real Postgres cache) does not vary between cases. `beforeEach` below resets
 * the two counters and restores default, successful behaviour, so every test
 * still starts from a known state.
 */
class ControllableGeocodingProvider implements GeocodingProvider {
  forwardCalls = 0;
  reverseCalls = 0;
  nextForward: (address: string) => Promise<GeocodedPoint | null> = () =>
    Promise.resolve(defaultGeocodedPoint());
  nextReverse: (latitude: number, longitude: number) => Promise<StructuredAddress | null> = () =>
    Promise.resolve(defaultStructuredAddress());

  forward(address: string): Promise<GeocodedPoint | null> {
    this.forwardCalls += 1;
    return this.nextForward(address);
  }

  reverse(latitude: number, longitude: number): Promise<StructuredAddress | null> {
    this.reverseCalls += 1;
    return this.nextReverse(latitude, longitude);
  }
}

interface GeocodeCacheRow {
  readonly normalised_address: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly place_id: string | null;
  readonly expires_at: Date;
  readonly created_at: Date;
}

type ForwardResponseBody =
  | {
      readonly status: 'ok';
      readonly latitude: number;
      readonly longitude: number;
      readonly placeId: string | null;
    }
  | { readonly status: 'no-result' }
  | { readonly status: 'unavailable' };

type ReverseResponseBody =
  | { readonly status: 'ok'; readonly address: StructuredAddress }
  | { readonly status: 'no-result' }
  | { readonly status: 'unavailable' };

/** A recognisable, never-real API key. `.env.example` marks this variable BILLABLE. */
const SENTINEL_GOOGLE_MAPS_API_KEY = 'AIzaSy-SENTINEL-DO-NOT-LOG';

/**
 * Unreachable limits, and a fresh pepper per run.
 *
 * The geocode policy is real and small — every call that reaches the provider
 * spends money — but its counters live in a Redis shared by every run on this
 * machine and survive for an hour. Without this override the suite passes once
 * and then answers 429 to everything for the rest of the hour, which is a
 * non-deterministic failure that has nothing to do with what is under test
 * here. `auth.otp.e2e.test.ts` and `auth.rate-limit.e2e.test.ts` take the same
 * escape hatch, and the limit itself is asserted where it is the subject.
 *
 * The per-run `keySecret` is the other half: it hashes this run's counters into
 * their own key space, so even the reduced traffic cannot collide with a
 * previous run's.
 */
const UNREACHABLE = 1_000_000;
const WINDOW_MS = 3_600_000;
const testRateLimits: RateLimitConfig = {
  keySecret: `geocoding-e2e-pepper-${randomUUID()}`,
  policies: {
    'otp-request': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'sign-in': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    refresh: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    geocode: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
  },
};

describe('geocoding endpoints over HTTP (issue #36)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let originalGoogleMapsKey: string | undefined;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let tokens: TokenService;
  let provider: ControllableGeocodingProvider;

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

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function cacheRow(rawAddress: string): Promise<GeocodeCacheRow | undefined> {
    const key = normaliseAddress(rawAddress);
    const result = await pool.query<GeocodeCacheRow>(
      'select normalised_address, latitude, longitude, place_id, expires_at, created_at ' +
        'from geocode_cache where normalised_address = $1',
      [key],
    );
    return result.rows[0];
  }

  async function cacheRowCountFor(rawAddress: string): Promise<number> {
    const key = normaliseAddress(rawAddress);
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from geocode_cache where normalised_address = $1',
      [key],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function totalCacheRowCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*) as count from geocode_cache',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Seeds a cache row directly, already expired — the only way to construct
   * "the cache has a stale answer" without waiting `GEOCODE_CACHE_TTL_DAYS`
   * in real time.
   */
  async function insertExpiredCacheRow(
    rawAddress: string,
    point: { latitude: number; longitude: number; placeId: string | null },
  ): Promise<void> {
    const key = normaliseAddress(rawAddress);
    await pool.query(
      `insert into geocode_cache
         (normalised_address, latitude, longitude, place_id, expires_at, created_at)
       values ($1, $2, $3, $4, now() - interval '1 day', now() - interval '31 days')`,
      [key, point.latitude, point.longitude, point.placeId],
    );
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    // Point the real `ConfigModule` at the throwaway database rather than
    // overriding `DATABASE_CONNECTION`, so the wiring under test is the
    // application's own — see the same note in `addresses.e2e.test.ts`.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    // Set BEFORE the module compiles, so the real, validated `AppConfig`
    // actually carries this value — `ConfigModule` parses `process.env` once,
    // at instantiation. The 'never logs the configured Google Maps API key'
    // test below depends on the sentinel being present in config even though
    // the fake provider below never reads it itself; the point of that test
    // is that nothing ELSE on the path (error handling, request logging,
    // health reporting) leaks it either.
    originalGoogleMapsKey = process.env.GOOGLE_MAPS_SERVER_API_KEY;
    process.env.GOOGLE_MAPS_SERVER_API_KEY = SENTINEL_GOOGLE_MAPS_API_KEY;

    provider = new ControllableGeocodingProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GEOCODING_PROVIDER)
      .useValue(provider)
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(testRateLimits)
      // NOT cosmetic. `Test.createTestingModule` installs Nest's
      // `TestingLogger` via `Logger.overrideLogger`, and that class overrides
      // `log`, `warn`, `debug` and `verbose` with EMPTY bodies — only `error`
      // reaches a real sink (`auth.otp.e2e.test.ts`, `auth.guards.e2e.test.ts`
      // and `auth.session-endpoints.e2e.test.ts` all learned this the same
      // way). Without this line, the "PII never reaches a log" suite below
      // would assert against a logger that already discards every `log`,
      // `warn` and `debug` call regardless of content, and would keep passing
      // if a future change started logging the API key or a coordinate at any
      // of those three levels.
      .setLogger(new ConsoleLogger())
      .compile();
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
    if (originalGoogleMapsKey === undefined) {
      delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    } else {
      process.env.GOOGLE_MAPS_SERVER_API_KEY = originalGoogleMapsKey;
    }
    await database.drop();
  });

  beforeEach(() => {
    provider.forwardCalls = 0;
    provider.reverseCalls = 0;
    provider.nextForward = () => Promise.resolve(defaultGeocodedPoint());
    provider.nextReverse = () => Promise.resolve(defaultStructuredAddress());
  });

  describe('POST /geocode/forward', () => {
    it('requires authentication', async () => {
      const res = await post('/geocode/forward').send({ address: uniqueAddress() });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signIn();

      const res = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a missing, empty, whitespace-only or oversized address', async () => {
      const caller = await signIn();

      const missing = await post('/geocode/forward', caller.accessToken).send({});
      const empty = await post('/geocode/forward', caller.accessToken).send({ address: '' });
      const whitespaceOnly = await post('/geocode/forward', caller.accessToken).send({
        address: '   ',
      });
      const oversized = await post('/geocode/forward', caller.accessToken).send({
        address: 'x'.repeat(301),
      });

      for (const res of [missing, empty, whitespaceOnly, oversized]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('answers ok with the geocoded point when the provider finds a place', async () => {
      const caller = await signIn();
      provider.nextForward = () =>
        Promise.resolve(
          defaultGeocodedPoint({ latitude: 40.377166, longitude: 49.892608, placeId: 'ChIJ-ok' }),
        );

      const res = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      expect(res.status).toBe(200);
      expect(res.body as ForwardResponseBody).toEqual({
        status: 'ok',
        latitude: 40.377166,
        longitude: 49.892608,
        placeId: 'ChIJ-ok',
      });
    });

    it('answers no-result when the provider answers and there is no such place', async () => {
      // ZERO_RESULTS is a final answer, not a failure — the address is well-
      // formed and the provider is healthy, it just does not exist. Retrying
      // costs money and returns the same thing, which is exactly why this is
      // a distinct, cheap-to-branch-on status rather than being folded into
      // `unavailable`.
      const caller = await signIn();
      provider.nextForward = () => Promise.resolve(null);

      const res = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      expect(res.status).toBe(200);
      expect(res.body as ForwardResponseBody).toEqual({ status: 'no-result' });
    });

    it('answers 200 unavailable, never a 5xx, when the provider throws', async () => {
      // A provider outage is Google's failure, two network hops away — not
      // evidence that this API is unhealthy. Answering 200 rather than 503
      // is deliberate: the documented client behaviour for this case is
      // falling back to manual address entry (`geocoding.types.ts`), which is
      // a normal, expected branch of this endpoint's contract, not an error
      // path. A 5xx here would also wrongly trip generic HTTP retry/backoff
      // and error-boundary logic built for "our server is broken", pointing
      // effort at the wrong system.
      const caller = await signIn();
      provider.nextForward = () => Promise.reject(new Error('simulated Maps API outage'));

      const res = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      expect(res.status).toBe(200);
      expect(res.body as ForwardResponseBody).toEqual({ status: 'unavailable' });
    });

    describe('the Postgres result cache', () => {
      it('hits the cache on a repeated lookup for the same address: one provider call, identical responses', async () => {
        const caller = await signIn();
        const address = uniqueAddress();
        provider.nextForward = () =>
          Promise.resolve(defaultGeocodedPoint({ placeId: 'ChIJ-cache-hit' }));

        const first = await post('/geocode/forward', caller.accessToken).send({ address });
        const second = await post('/geocode/forward', caller.accessToken).send({ address });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(provider.forwardCalls).toBe(1);
      });

      it('keys the cache on the normalised address: two differently-spelled requests for one place produce one provider call and one row', async () => {
        const caller = await signIn();
        const [padded, plain] = addressSpellingPair();
        provider.nextForward = () =>
          Promise.resolve(defaultGeocodedPoint({ placeId: 'ChIJ-normalised-key' }));

        const first = await post('/geocode/forward', caller.accessToken).send({
          address: padded,
        });
        const second = await post('/geocode/forward', caller.accessToken).send({
          address: plain,
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(provider.forwardCalls).toBe(1);
        // Both spellings normalise to the same key, so this is the same
        // count read twice, not two different rows.
        expect(await cacheRowCountFor(padded)).toBe(1);
        expect(await cacheRowCountFor(plain)).toBe(1);
      });

      it('treats an expired row as a miss: calls the provider again and refreshes the row', async () => {
        const caller = await signIn();
        const address = uniqueAddress();
        await insertExpiredCacheRow(address, {
          latitude: 1.1,
          longitude: 2.2,
          placeId: 'stale-place',
        });
        const staleRow = await cacheRow(address);
        expect(staleRow).toBeDefined();
        provider.nextForward = () =>
          Promise.resolve(
            defaultGeocodedPoint({ latitude: 40.5, longitude: 49.5, placeId: 'fresh-place' }),
          );

        const res = await post('/geocode/forward', caller.accessToken).send({ address });

        expect(res.status).toBe(200);
        expect(res.body as ForwardResponseBody).toEqual({
          status: 'ok',
          latitude: 40.5,
          longitude: 49.5,
          placeId: 'fresh-place',
        });
        expect(provider.forwardCalls).toBe(1);

        const refreshed = await cacheRow(address);
        expect(refreshed).toBeDefined();
        expect(refreshed?.latitude).toBe(40.5);
        expect(refreshed?.longitude).toBe(49.5);
        expect(refreshed?.place_id).toBe('fresh-place');
        expect(refreshed?.expires_at.getTime()).toBeGreaterThan(Date.now());
        expect(refreshed?.expires_at.getTime()).not.toBe(staleRow?.expires_at.getTime());
      });

      it('writes no row when the provider fails, and leaves an already-cached, unrelated address untouched', async () => {
        const caller = await signIn();
        const cachedAddress = uniqueAddress();
        provider.nextForward = () =>
          Promise.resolve(defaultGeocodedPoint({ placeId: 'ChIJ-untouched' }));
        const seeded = await post('/geocode/forward', caller.accessToken).send({
          address: cachedAddress,
        });
        expect(seeded.status).toBe(200);
        const seededRow = await cacheRow(cachedAddress);
        expect(seededRow).toBeDefined();

        const failingAddress = uniqueAddress();
        provider.nextForward = () => Promise.reject(new Error('simulated outage'));

        const res = await post('/geocode/forward', caller.accessToken).send({
          address: failingAddress,
        });

        expect(res.status).toBe(200);
        expect(res.body as ForwardResponseBody).toEqual({ status: 'unavailable' });
        expect(await cacheRowCountFor(failingAddress)).toBe(0);
        // The earlier, unrelated cache row must survive this unrelated
        // failure byte-for-byte — a failure handler that clears the whole
        // table (or the whole row set touched by the same request) rather
        // than simply declining to write would silently degrade every other
        // cached address too.
        expect(await cacheRow(cachedAddress)).toEqual(seededRow);
      });

      it('leaves a stale row in place when the refresh attempt itself fails, rather than evicting it', async () => {
        const caller = await signIn();
        const address = uniqueAddress();
        await insertExpiredCacheRow(address, {
          latitude: 3.3,
          longitude: 4.4,
          placeId: 'still-here',
        });
        const before = await cacheRow(address);
        provider.nextForward = () => Promise.reject(new Error('simulated outage during refresh'));

        const res = await post('/geocode/forward', caller.accessToken).send({ address });

        expect(res.status).toBe(200);
        expect(res.body as ForwardResponseBody).toEqual({ status: 'unavailable' });
        // Stale beats gone: a failed refresh must not delete the row a
        // future retry could still have refreshed.
        const after = await cacheRow(address);
        expect(after).toEqual(before);
      });
    });
  });

  describe('POST /geocode/reverse', () => {
    it('requires authentication', async () => {
      const res = await post('/geocode/reverse').send({ latitude: 40.4, longitude: 49.8 });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown field — the body is a strict object', async () => {
      const caller = await signIn();

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: 49.8,
        extra: 'not allowed',
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a missing latitude or a missing longitude', async () => {
      const caller = await signIn();

      const missingBoth = await post('/geocode/reverse', caller.accessToken).send({});
      const missingLongitude = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
      });
      const missingLatitude = await post('/geocode/reverse', caller.accessToken).send({
        longitude: 49.8,
      });

      for (const res of [missingBoth, missingLongitude, missingLatitude]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects a non-numeric latitude', async () => {
      const caller = await signIn();

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 'forty',
        longitude: 49.8,
      });

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an out-of-range latitude or longitude', async () => {
      const caller = await signIn();

      const highLatitude = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 91,
        longitude: 49.8,
      });
      const lowLatitude = await post('/geocode/reverse', caller.accessToken).send({
        latitude: -91,
        longitude: 49.8,
      });
      const highLongitude = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: 181,
      });
      const lowLongitude = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: -181,
      });

      for (const res of [highLatitude, lowLatitude, highLongitude, lowLongitude]) {
        expect(res.status).toBe(422);
        expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('answers ok with the structured address when the provider resolves the point', async () => {
      const caller = await signIn();
      const address = defaultStructuredAddress({ placeId: 'ChIJ-reverse-ok' });
      provider.nextReverse = () => Promise.resolve(address);

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: address.latitude,
        longitude: address.longitude,
      });

      expect(res.status).toBe(200);
      expect(res.body as ReverseResponseBody).toEqual({ status: 'ok', address });
    });

    it('answers no-result when the provider answers and there is nothing at that point', async () => {
      const caller = await signIn();
      provider.nextReverse = () => Promise.resolve(null);

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 0,
        longitude: 0,
      });

      expect(res.status).toBe(200);
      expect(res.body as ReverseResponseBody).toEqual({ status: 'no-result' });
    });

    it('answers 200 unavailable, never a 5xx, when the provider throws', async () => {
      const caller = await signIn();
      provider.nextReverse = () => Promise.reject(new Error('simulated outage'));

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: 49.8,
      });

      expect(res.status).toBe(200);
      expect(res.body as ReverseResponseBody).toEqual({ status: 'unavailable' });
    });

    it('never caches a reverse lookup: two identical requests call the provider twice, and geocode_cache stays empty for them', async () => {
      // Google's Maps Service Specific Terms draw the caching line at the
      // POINT, not the place. §6.3.1 permits caching latitude/longitude from
      // the Geocoding API for up to 30 consecutive calendar days; §6.3.2
      // permits keeping a `formatted_address` only in a cache "logically
      // isolated to the specific End User it is associated with and must not
      // be used across multiple End Users". `geocode_cache` is one shared
      // table serving every caller — the entire value of this endpoint's
      // answer is the address text attached to a point, so a shared cache
      // that kept it would breach §6.3.2 the moment two different customers
      // reverse-geocode near the same spot, and a shared cache that kept only
      // the point while discarding the address would be pointless to build.
      // Never caching reverse lookups here is the only shape of this
      // endpoint that is both licensed and useful for every caller — not an
      // optimisation left undone.
      const caller = await signIn();
      const before = await totalCacheRowCount();
      provider.nextReverse = () =>
        Promise.resolve(defaultStructuredAddress({ placeId: 'ChIJ-never-cached' }));

      const first = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: 49.8,
      });
      const second = await post('/geocode/reverse', caller.accessToken).send({
        latitude: 40.4,
        longitude: 49.8,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(provider.reverseCalls).toBe(2);
      expect(await totalCacheRowCount()).toBe(before);
    });
  });

  describe('PII never reaches a log or a response body', () => {
    let sink: string[];
    let spies: MockInstance[];

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
      // because nothing was captured — see `log-sink.ts`'s own note.
      new Logger('geocoding.e2e.test').log('canary-message-should-be-captured');

      expect(sink.some((entry) => entry.includes('canary-message-should-be-captured'))).toBe(true);
    });

    it('never logs the configured Google Maps API key, across a success, a no-result and a provider failure', async () => {
      const caller = await signIn();

      provider.nextForward = () => Promise.resolve(defaultGeocodedPoint());
      const ok = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      provider.nextForward = () => Promise.resolve(null);
      const noResult = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      provider.nextForward = () => Promise.reject(new Error('simulated outage'));
      const unavailable = await post('/geocode/forward', caller.accessToken).send({
        address: uniqueAddress(),
      });

      for (const res of [ok, noResult, unavailable]) {
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(SENTINEL_GOOGLE_MAPS_API_KEY);
      }
      expect(sink.join('\n')).not.toContain(SENTINEL_GOOGLE_MAPS_API_KEY);
    });

    it('never logs a reverse-lookup coordinate', async () => {
      const caller = await signIn();
      // Distinctive enough that these exact digit sequences are vanishingly
      // unlikely to appear in this sink for any other reason (a request id,
      // a port number, a timestamp), which is what makes their absence below
      // mean something.
      const DISTINCTIVE_LATITUDE = 40.111222;
      const DISTINCTIVE_LONGITUDE = 49.333444;
      provider.nextReverse = () =>
        Promise.resolve(
          defaultStructuredAddress({
            latitude: DISTINCTIVE_LATITUDE,
            longitude: DISTINCTIVE_LONGITUDE,
          }),
        );

      const res = await post('/geocode/reverse', caller.accessToken).send({
        latitude: DISTINCTIVE_LATITUDE,
        longitude: DISTINCTIVE_LONGITUDE,
      });
      expect(res.status).toBe(200);

      const combined = sink.join('\n');
      expect(combined).not.toContain(String(DISTINCTIVE_LATITUDE));
      expect(combined).not.toContain(String(DISTINCTIVE_LONGITUDE));
    });
  });
});

/**
 * The geocode budget itself, which the suite above deliberately disables.
 *
 * **A rule only counts if it can fail** (CLAUDE.md §14). `auth.rate-limit.e2e.test.ts`
 * already proves the guard mechanism works; what is untested without this is the
 * thing that is easy to get wrong and impossible to notice — whether the
 * decorator is actually attached to *these two routes*, under the *geocode*
 * policy. A missing `@RateLimit` here would leave a billable upstream call
 * behind an unlimited endpoint, and every other test in this file would still
 * be green.
 *
 * Its own app, because the budget has to be small here and unreachable there,
 * and a policy is chosen when the module is built.
 */
describe('the geocode endpoints spend from a budget (issue #36)', () => {
  const PER_IDENTIFIER = 2;
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;

  const budgeted: RateLimitConfig = {
    keySecret: `geocoding-budget-pepper-${randomUUID()}`,
    policies: {
      ...testRateLimits.policies,
      geocode: {
        perIdentifier: PER_IDENTIFIER,
        // Unreachable, so a 429 can only have come from the per-user
        // dimension — an IP limit that also fired would make it ambiguous
        // which one produced it.
        perIp: UNREACHABLE,
        windowMs: WINDOW_MS,
        backoffCeilingMs: WINDOW_MS,
      },
    },
  };

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GEOCODING_PROVIDER)
      .useValue(new ControllableGeocodingProvider())
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(budgeted)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
  });

  async function tokenFor(): Promise<string> {
    // Reuses the file's own `nextPhone()` counter rather than a random
    // number: `users.phone_e164` is unique among live rows, and only a
    // counter actually guarantees that. A `Math.random()` collision here
    // would fail with a confusing unique-constraint error instead of the
    // rate-limit assertion this describe block exists to make.
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: ['customer'] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return pair.accessToken;
  }

  it('answers 429 once a caller has spent its hourly geocode budget', async () => {
    const accessToken = await tokenFor();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < PER_IDENTIFIER + 1; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post('/geocode/forward')
        .set('authorization', `Bearer ${accessToken}`)
        .send({ address: `Nizami ${String(attempt)}` });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, PER_IDENTIFIER)).toEqual(Array(PER_IDENTIFIER).fill(200));
    expect(statuses.at(-1)).toBe(429);
  });

  it('budgets the reverse endpoint too, and per caller rather than globally', async () => {
    // The two routes share one policy on purpose — they cost the same money —
    // but each caller gets their own budget, or one busy customer would lock
    // out everybody else.
    const spender = await tokenFor();
    for (let attempt = 0; attempt < PER_IDENTIFIER; attempt += 1) {
      await request(app.getHttpServer())
        .post('/geocode/reverse')
        .set('authorization', `Bearer ${spender}`)
        .send({ latitude: 40.4, longitude: 49.8 });
    }

    const exhausted = await request(app.getHttpServer())
      .post('/geocode/reverse')
      .set('authorization', `Bearer ${spender}`)
      .send({ latitude: 40.4, longitude: 49.8 });
    expect(exhausted.status).toBe(429);

    const bystander = await request(app.getHttpServer())
      .post('/geocode/reverse')
      .set('authorization', `Bearer ${await tokenFor()}`)
      .send({ latitude: 40.4, longitude: 49.8 });
    expect(bystander.status).toBe(200);
  });
});
