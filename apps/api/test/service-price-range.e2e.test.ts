import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ServicePriceRange } from '@tezusta/types';
import Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { MasterVerificationStatusName } from '../src/infra/database/schema/masters';
import { runSeed } from '../src/infra/database/seed';
import { CATALOGUE_CACHE_PREFIX } from '../src/modules/services/services.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `GET /services/:id/price-range` over real HTTP, through the real
 * `AppModule` graph — the same construction as `service-catalogue.e2e.test.ts`
 * and `master-availability.e2e.test.ts`, which this file follows closely.
 *
 * What only this layer can prove: that the aggregate genuinely excludes a
 * suspended, unverified, or paused-offer master's price rather than merely
 * intending to; that an inspection-priced service never carries a range; that
 * a service nobody currently offers answers 200 with a renderable body
 * instead of a 500; and that a single eligible master produces a legitimate
 * degenerate range (`minMinor === maxMinor`) rather than something the
 * endpoint treats as an error. None of that is visible from a unit test of
 * `MastersRepository.getEligiblePriceRange` against a mocked database.
 *
 * Every test builds its own dedicated service (and, where needed, its own
 * category) via direct SQL rather than reusing a seeded catalogue slug —
 * `master_services` rows persist for the life of the suite, and two tests
 * sharing a service would let one test's masters leak into another's
 * aggregate.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

describe('GET /services/:id/price-range (issue #84)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let redis: Redis;
  let categoryId: string;

  async function clearCatalogueCache(): Promise<void> {
    const keys = await redis.keys(`${CATALOGUE_CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  /** A fixed-price service, in its own never-reused category-adjacent row. */
  async function createFixedService(basePriceMinor = 2000): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into services (id, category_id, slug, name, pricing_kind, base_price_minor, is_active)
       values ($1, $2, $3, $4, 'fixed', $5, true)`,
      [id, categoryId, `price-range-fixed-${id}`, { az: 'Qiymət aralığı testi' }, basePriceMinor],
    );
    return id;
  }

  async function createInspectionService(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into services (id, category_id, slug, name, pricing_kind, base_price_minor, is_active)
       values ($1, $2, $3, $4, 'inspection', null, true)`,
      [id, categoryId, `price-range-inspection-${id}`, { az: 'Baxışdan sonra qiymət' }],
    );
    return id;
  }

  /** A master row, directly, with the given verification status. */
  async function createMaster(status: MasterVerificationStatusName = 'active'): Promise<string> {
    const masterId = randomUUID();
    const userId = randomUUID();
    await pool.query(`insert into users (id, phone_e164) values ($1, $2)`, [userId, nextPhone()]);
    await pool.query(
      `insert into masters (id, user_id, display_name, verification_status)
       values ($1, $2, $3, $4)`,
      [masterId, userId, `Usta ${masterId.slice(0, 8)}`, status],
    );
    return masterId;
  }

  async function offerService(
    masterId: string,
    serviceId: string,
    priceMinor: number | null,
    isActive = true,
  ): Promise<void> {
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, $3, $4)`,
      [masterId, serviceId, priceMinor, isActive],
    );
  }

  async function getPriceRange(serviceId: string) {
    return request(app.getHttpServer()).get(`/services/${serviceId}/price-range`);
  }

  beforeAll(async () => {
    const env = parseEnv(process.env);
    database = await createThrowawayDatabase(env.database.url);
    await runMigrations(database.url);
    await runSeed(database.url);

    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    redis = new Redis(env.redis.url);

    const categories = await pool.query<{ id: string }>(
      'select id from service_categories limit 1',
    );
    categoryId = categories.rows[0]?.id ?? '';
    expect(categoryId).not.toBe('');
  }, 60_000);

  afterAll(async () => {
    await clearCatalogueCache();
    await redis.quit();
    await pool.end();
    await app.close();
    await database.drop();
  });

  it('answers without a token — a public read, like GET /services/:id', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 1500);

    const res = await getPriceRange(serviceId);

    expect(res.status).toBe(200);
  });

  it('returns the true min and max across several eligible masters', async () => {
    const serviceId = await createFixedService();
    const a = await createMaster('active');
    const b = await createMaster('active');
    const c = await createMaster('active');
    await offerService(a, serviceId, 3000);
    await offerService(b, serviceId, 5000);
    await offerService(c, serviceId, 4000);

    const res = await getPriceRange(serviceId);

    expect(res.status).toBe(200);
    expect(res.body as ServicePriceRange).toEqual({
      pricingKind: 'fixed',
      range: { minMinor: 3000, maxMinor: 5000, currency: 'AZN' },
    });
  });

  it('sends the range as integer minor units, never a string or a formatted amount', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 123_456);

    const res = await getPriceRange(serviceId);

    const body = res.body as ServicePriceRange & { range: { minMinor: number; maxMinor: number } };
    expect(typeof body.range.minMinor).toBe('number');
    expect(typeof body.range.maxMinor).toBe('number');
    expect(Number.isInteger(body.range.minMinor)).toBe(true);
    expect(Number.isInteger(body.range.maxMinor)).toBe(true);
    expect(body.range.minMinor).toBe(123_456);
  });

  it('produces a legitimate degenerate range for a single eligible master', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 4200);

    const res = await getPriceRange(serviceId);

    expect(res.status).toBe(200);
    expect(res.body as ServicePriceRange).toEqual({
      pricingKind: 'fixed',
      range: { minMinor: 4200, maxMinor: 4200, currency: 'AZN' },
    });
  });

  it('excludes a pending_verification (unverified) master from the range', async () => {
    const serviceId = await createFixedService();
    const eligible = await createMaster('active');
    const unverified = await createMaster('pending_verification');
    await offerService(eligible, serviceId, 2500);
    await offerService(unverified, serviceId, 100); // would move the min if counted

    const res = await getPriceRange(serviceId);

    expect(res.body as ServicePriceRange).toEqual({
      pricingKind: 'fixed',
      range: { minMinor: 2500, maxMinor: 2500, currency: 'AZN' },
    });
  });

  it('excludes a suspended master from the range', async () => {
    const serviceId = await createFixedService();
    const eligible = await createMaster('active');
    const suspended = await createMaster('active');
    await offerService(eligible, serviceId, 2500);
    await offerService(suspended, serviceId, 999_999); // would move the max if counted
    await pool.query(
      `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
      [suspended],
    );

    const res = await getPriceRange(serviceId);

    expect(res.body as ServicePriceRange).toEqual({
      pricingKind: 'fixed',
      range: { minMinor: 2500, maxMinor: 2500, currency: 'AZN' },
    });
  });

  it('excludes a master whose offer for this service is paused (is_active = false)', async () => {
    const serviceId = await createFixedService();
    const eligible = await createMaster('active');
    const paused = await createMaster('active');
    await offerService(eligible, serviceId, 2500);
    await offerService(paused, serviceId, 1, false); // would move the min if counted

    const res = await getPriceRange(serviceId);

    expect(res.body as ServicePriceRange).toEqual({
      pricingKind: 'fixed',
      range: { minMinor: 2500, maxMinor: 2500, currency: 'AZN' },
    });
  });

  it('answers a renderable result, not a 500, for a service nobody currently offers', async () => {
    const serviceId = await createFixedService();

    const res = await getPriceRange(serviceId);

    expect(res.status).toBe(200);
    expect(res.body as ServicePriceRange).toEqual({ pricingKind: 'fixed', range: null });
  });

  it('returns the mode and no range for an inspection-priced service, even with eligible masters', async () => {
    const serviceId = await createInspectionService();
    const master = await createMaster('active');
    // An inspection service carries no price on master_services either.
    await offerService(master, serviceId, null);

    const res = await getPriceRange(serviceId);

    expect(res.status).toBe(200);
    expect(res.body as ServicePriceRange).toEqual({ pricingKind: 'inspection', range: null });
  });

  it('leaks no field beyond the documented contract', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 1000);

    const res = await getPriceRange(serviceId);

    expect(Object.keys(res.body as object).sort()).toEqual(['pricingKind', 'range']);
    expect(Object.keys((res.body as ServicePriceRange).range as object).sort()).toEqual([
      'currency',
      'maxMinor',
      'minMinor',
    ]);
  });

  it('answers 404 for a service id that never existed', async () => {
    const res = await getPriceRange(randomUUID());
    expect(res.status).toBe(404);
    expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
  });

  /**
   * `getPriceRange` shares `getServiceById`'s cache key and used to inherit
   * its bug: `CacheService.readThrough` writes whatever `load()` returns, and
   * `{ v: null }` is a perfectly well-formed cache hit — so a 404 for a
   * random uuid was writing a Redis key with a ~63s TTL on this route too,
   * on top of it being unauthenticated *and* unrate-limited before this PR's
   * fixes. ADR-0020 says "the cache never holds an absence"; this is the test
   * that makes it true for this endpoint specifically, the way
   * `service-catalogue.e2e.test.ts`'s `categoryId` test already does for the
   * catalogue listing.
   */
  it('leaves no cache key behind for a service id that never existed', async () => {
    const attempted: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomUUID();
      attempted.push(id);
      const res = await getPriceRange(id);
      expect(res.status).toBe(404);
    }

    const keys = await redis.keys(`${CATALOGUE_CACHE_PREFIX}service:*`);
    for (const id of attempted) {
      expect(keys.some((key) => key.includes(id))).toBe(false);
    }
  });

  it('answers 404 for a deactivated service, not a stale range', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 1000);
    await pool.query('update services set is_active = false where id = $1', [serviceId]);
    await clearCatalogueCache();

    const res = await getPriceRange(serviceId);
    expect(res.status).toBe(404);
  });

  it('answers 422, not 500, for an id that is not a UUID', async () => {
    const res = await request(app.getHttpServer())
      .get('/services/not-a-uuid/price-range')
      .expect(422);
    expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('recomputes on every request rather than caching a stale range', async () => {
    const serviceId = await createFixedService();
    const master = await createMaster('active');
    await offerService(master, serviceId, 1000);

    const first = await getPriceRange(serviceId);
    expect((first.body as ServicePriceRange).range).toEqual({
      minMinor: 1000,
      maxMinor: 1000,
      currency: 'AZN',
    });

    const second = await createMaster('active');
    await offerService(second, serviceId, 9000);

    const after = await getPriceRange(serviceId);
    expect((after.body as ServicePriceRange).range).toEqual({
      minMinor: 1000,
      maxMinor: 9000,
      currency: 'AZN',
    });
  });
});
