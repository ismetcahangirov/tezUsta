import { randomUUID } from 'node:crypto';

import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { CATALOGUE_CACHE_PREFIX } from '../src/modules/services/services.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

const AN_UNKNOWN_UUID = '01900000-0000-7000-8000-00000000dead';

interface CategoryBody {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly displayOrder: number;
}

interface ServiceBody extends CategoryBody {
  readonly categoryId: string;
  readonly pricing:
    | { readonly kind: 'fixed'; readonly amountMinor: number; readonly currency: string }
    | { readonly kind: 'inspection' };
}

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

describe('the public service catalogue endpoints', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let redis: Redis;

  /**
   * Redis is shared by every test run on this machine, and the cache key does
   * not name a database — it has no reason to in production, where there is
   * one. Clearing the prefix before each test is what stops a value cached
   * from a previous run's throwaway database from being served into this one,
   * which would make a green test mean nothing.
   */
  async function clearCatalogueCache(): Promise<void> {
    const keys = await redis.keys(`${CATALOGUE_CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
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
    redis = new Redis(env.redis.url);
  }, 60_000);

  afterAll(async () => {
    await clearCatalogueCache();
    await redis.quit();
    await pool.end();
    await app.close();
    await database.drop();
  });

  beforeEach(async () => {
    await clearCatalogueCache();
  });

  describe('GET /services/categories', () => {
    it('answers without a token, which is the whole point of a public catalogue', async () => {
      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);

      const body = response.body as Page<CategoryBody>;
      expect(body.items).toHaveLength(10);
      expect(body.items[0]?.slug).toBe('plumbing');
      expect(body.items.at(-1)?.slug).toBe('other');
    });

    it('returns display order, not insertion order or alphabetical order', async () => {
      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);

      const orders = (response.body as Page<CategoryBody>).items.map((item) => item.displayOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    it('leaks no operational field — no active flag, no timestamps', async () => {
      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);

      const [first] = (response.body as Page<CategoryBody>).items;
      expect(Object.keys(first ?? {}).sort()).toEqual(['displayOrder', 'id', 'name', 'slug']);
    });

    it('omits a deactivated category', async () => {
      await pool.query(`UPDATE service_categories SET is_active = false WHERE slug = 'painting'`);

      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);
      const slugs = (response.body as Page<CategoryBody>).items.map((item) => item.slug);

      expect(slugs).not.toContain('painting');
      await pool.query(`UPDATE service_categories SET is_active = true WHERE slug = 'painting'`);
    });
  });

  describe('GET /services', () => {
    it('returns the active services, in display order', async () => {
      const response = await request(app.getHttpServer()).get('/services').expect(200);
      const body = response.body as Page<ServiceBody>;

      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((item) => typeof item.categoryId === 'string')).toBe(true);
    });

    /**
     * Issue #65. `display_order` used to be the service's index *within* its
     * category, and this listing sorts by `(display_order, id)` across the
     * whole table — so it returned every category's first service, then every
     * category's second, and categories came back interleaved.
     *
     * The assertion is on grouping rather than on an exact slug sequence: what
     * was decided is that a service is listed next to the others in its
     * category and that categories follow their own `display_order`. Pinning
     * the 33 slugs in order would also fail the first time the owner adds a
     * service, which is not a regression.
     */
    it('groups services by category, categories in their own display order', async () => {
      const categories = await request(app.getHttpServer())
        .get('/services/categories?limit=100')
        .expect(200);
      const orderByCategoryId = new Map(
        (categories.body as Page<CategoryBody>).items.map((item) => [item.id, item.displayOrder]),
      );

      const response = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const items = (response.body as Page<ServiceBody>).items;
      expect(items.length).toBeGreaterThan(10);

      const sequence = items.map((item) => orderByCategoryId.get(item.categoryId));
      expect(sequence.every((order) => typeof order === 'number')).toBe(true);

      // Non-decreasing is both halves of the claim at once: it can only hold
      // if each category's services are contiguous AND the runs appear in
      // category display order.
      const runs = sequence.filter((order, index) => order !== sequence[index - 1]);
      expect(runs).toEqual([...runs].sort((a, b) => Number(a) - Number(b)));
      expect(new Set(runs).size).toBe(runs.length);
    });

    it('distinguishes a fixed price from a price set after inspection', async () => {
      const response = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const items = (response.body as Page<ServiceBody>).items;

      const fixed = items.find((item) => item.slug === 'leak-repair');
      const inspection = items.find((item) => item.slug === 'washing-machine-repair');

      expect(fixed?.pricing).toEqual({ kind: 'fixed', amountMinor: 2500, currency: 'AZN' });
      expect(inspection?.pricing).toEqual({ kind: 'inspection' });
    });

    it('sends the price as integer minor units, never a formatted string', async () => {
      const response = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const fixed = (response.body as Page<ServiceBody>).items.find(
        (item) => item.pricing.kind === 'fixed',
      );

      expect(typeof (fixed?.pricing as { amountMinor: number }).amountMinor).toBe('number');
      expect(Number.isInteger((fixed?.pricing as { amountMinor: number }).amountMinor)).toBe(true);
    });

    it('filters by category', async () => {
      const categories = await request(app.getHttpServer()).get('/services/categories').expect(200);
      const plumbing = (categories.body as Page<CategoryBody>).items.find(
        (item) => item.slug === 'plumbing',
      );

      const response = await request(app.getHttpServer())
        .get(`/services?categoryId=${String(plumbing?.id)}`)
        .expect(200);
      const items = (response.body as Page<ServiceBody>).items;

      expect(items).toHaveLength(5);
      expect(items.every((item) => item.categoryId === plumbing?.id)).toBe(true);
    });

    it('omits a deactivated service', async () => {
      await pool.query(`UPDATE services SET is_active = false WHERE slug = 'tap-replacement'`);

      const response = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const slugs = (response.body as Page<ServiceBody>).items.map((item) => item.slug);

      expect(slugs).not.toContain('tap-replacement');
      await pool.query(`UPDATE services SET is_active = true WHERE slug = 'tap-replacement'`);
    });

    it('pages by cursor without repeating or skipping a row', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 20; page += 1) {
        const url: string =
          cursor === null
            ? '/services?limit=4'
            : `/services?limit=4&cursor=${encodeURIComponent(cursor)}`;
        const response = await request(app.getHttpServer()).get(url).expect(200);
        const body = response.body as Page<ServiceBody>;

        seen.push(...body.items.map((item) => item.slug));
        cursor = body.nextCursor;
        if (cursor === null) {
          break;
        }
      }

      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(33);
    });

    it('treats a malformed cursor as the start of the list rather than an error', async () => {
      const response = await request(app.getHttpServer())
        .get('/services?cursor=not-a-real-cursor')
        .expect(200);

      expect((response.body as Page<ServiceBody>).items.length).toBeGreaterThan(0);
    });

    it('rejects a limit above the cap instead of honouring it', async () => {
      await request(app.getHttpServer()).get('/services?limit=100000').expect(422);
    });

    it('rejects an unknown query parameter rather than silently ignoring it', async () => {
      await request(app.getHttpServer()).get('/services?catagoryId=oops').expect(422);
    });
  });

  describe('GET /services/:id', () => {
    async function anyServiceId(): Promise<string> {
      const response = await request(app.getHttpServer()).get('/services?limit=1').expect(200);
      return (response.body as Page<ServiceBody>).items[0]?.id ?? '';
    }

    it('returns the one service', async () => {
      const id = await anyServiceId();
      const response = await request(app.getHttpServer()).get(`/services/${id}`).expect(200);

      expect((response.body as ServiceBody).id).toBe(id);
    });

    it('answers 404 for an id that never existed', async () => {
      await request(app.getHttpServer()).get(`/services/${AN_UNKNOWN_UUID}`).expect(404);
    });

    it('answers 404 for a deactivated service, not 200 and not 410', async () => {
      const id = await anyServiceId();
      await pool.query('UPDATE services SET is_active = false WHERE id = $1', [id]);
      await clearCatalogueCache();

      await request(app.getHttpServer()).get(`/services/${id}`).expect(404);
      await pool.query('UPDATE services SET is_active = true WHERE id = $1', [id]);
    });

    it('answers 422, not 500, for an id that is not a UUID', async () => {
      await request(app.getHttpServer()).get('/services/not-a-uuid').expect(422);
    });
  });

  describe('language', () => {
    it('answers in Azerbaijani when nothing is asked for', async () => {
      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);
      const plumbing = (response.body as Page<CategoryBody>).items.find(
        (item) => item.slug === 'plumbing',
      );

      expect(plumbing?.name).toBe('Santexnika');
    });

    it('answers in English when English is preferred', async () => {
      const response = await request(app.getHttpServer())
        .get('/services/categories')
        .set('Accept-Language', 'en-GB,en;q=0.9')
        .expect(200);
      const plumbing = (response.body as Page<CategoryBody>).items.find(
        (item) => item.slug === 'plumbing',
      );

      expect(plumbing?.name).toBe('Plumbing');
    });

    it('falls back to Azerbaijani for a language nothing is translated into', async () => {
      const response = await request(app.getHttpServer())
        .get('/services/categories')
        .set('Accept-Language', 'ru,de;q=0.8')
        .expect(200);
      const plumbing = (response.body as Page<CategoryBody>).items.find(
        (item) => item.slug === 'plumbing',
      );

      expect(plumbing?.name).toBe('Santexnika');
    });

    it('survives a hostile Accept-Language header without failing the request', async () => {
      await request(app.getHttpServer())
        .get('/services/categories')
        .set('Accept-Language', `${'a'.repeat(400)};q=notanumber,,,*;q=9`)
        .expect(200);
    });
  });

  describe('caching', () => {
    it('serves a repeated request from the cache rather than the database', async () => {
      await request(app.getHttpServer()).get('/services/categories').expect(200);

      // Written behind the application's back, so the only way it can be
      // absent from the next response is that the response never reached
      // Postgres.
      await pool.query(
        `INSERT INTO service_categories (id, slug, name, display_order)
         VALUES ($1, 'cache-probe', '{"az":"Keş yoxlaması"}', 99)`,
        [AN_UNKNOWN_UUID],
      );

      const second = await request(app.getHttpServer()).get('/services/categories').expect(200);
      const slugs = (second.body as Page<CategoryBody>).items.map((item) => item.slug);
      expect(slugs).not.toContain('cache-probe');

      await clearCatalogueCache();
      const third = await request(app.getHttpServer()).get('/services/categories').expect(200);
      expect((third.body as Page<CategoryBody>).items.map((item) => item.slug)).toContain(
        'cache-probe',
      );

      await pool.query('DELETE FROM service_categories WHERE id = $1', [AN_UNKNOWN_UUID]);
    });

    it('tells shared caches the response varies by language', async () => {
      const response = await request(app.getHttpServer()).get('/services/categories').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(String(response.headers['vary'])).toMatch(/Accept-Language/i);
    });
  });

  describe('hostile and edge-case input', () => {
    /**
     * `display_order` is Postgres `integer`. A cursor whose sort position sits
     * outside int4 used to pass validation, reach the query as a bound
     * parameter, and come back as `22003 integer out of range` — a 500 on a
     * public endpoint, from a string anybody can construct.
     */
    it('answers a cursor whose position cannot fit the column, rather than failing', async () => {
      const outOfRange = Buffer.from(
        JSON.stringify({ o: 2_147_483_648, i: AN_UNKNOWN_UUID }),
        'utf8',
      ).toString('base64url');

      const response = await request(app.getHttpServer())
        .get(`/services?cursor=${encodeURIComponent(outOfRange)}`)
        .expect(200);

      expect((response.body as Page<ServiceBody>).items.length).toBeGreaterThan(0);
    });

    it('never marks an error response publicly cacheable', async () => {
      const notFound = await request(app.getHttpServer())
        .get(`/services/${AN_UNKNOWN_UUID}`)
        .expect(404);
      const invalid = await request(app.getHttpServer()).get('/services?limit=100000').expect(422);

      expect(notFound.headers['cache-control']).toBeUndefined();
      expect(invalid.headers['cache-control']).toBeUndefined();
    });

    /**
     * ADR-0020: "A 404 is never cached ... Caching 'this id does not exist'
     * would let anyone turn a public endpoint into a way to fill Redis one
     * random UUID at a time." `CacheService.readThrough`'s `{ v: value }`
     * envelope makes `null` a cacheable value, and `getServiceById` used to
     * hand it exactly that — every 404 for a random uuid wrote
     * `catalogue:v1:service:<uuid>` to Redis with a TTL, one key per request,
     * on an unauthenticated route. This is the regression test that
     * guarantee never had.
     */
    it('leaves no cache key behind for a service id that never existed', async () => {
      const attempted: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const id = randomUUID();
        attempted.push(id);
        await request(app.getHttpServer()).get(`/services/${id}`).expect(404);
      }

      const keys = await redis.keys(`${CATALOGUE_CACHE_PREFIX}service:*`);
      for (const id of attempted) {
        expect(keys.some((key) => key.includes(id))).toBe(false);
      }
    });

    /**
     * `categoryId` is validated as a UUID and nothing more, so it names a
     * category or it names nothing. If an unknown one reached the cache key,
     * an anonymous caller would have an unlimited supply of them.
     */
    it('answers an unknown categoryId without minting a cache key for it', async () => {
      // One unknown id first, so the fixed keys this path needs — the set of
      // active category ids — already exist. The property under test is that
      // the count then stops growing, not that it never grew.
      await request(app.getHttpServer()).get(`/services?categoryId=${randomUUID()}`).expect(200);
      const before = await redis.keys(`${CATALOGUE_CACHE_PREFIX}*`);

      const attempted: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const categoryId = randomUUID();
        attempted.push(categoryId);
        const response = await request(app.getHttpServer())
          .get(`/services?categoryId=${categoryId}`)
          .expect(200);
        expect((response.body as Page<ServiceBody>).items).toHaveLength(0);
      }

      const after = await redis.keys(`${CATALOGUE_CACHE_PREFIX}*`);
      expect(after.length).toBe(before.length);
      for (const categoryId of attempted) {
        expect(after.some((key) => key.includes(categoryId))).toBe(false);
      }
    });

    /** Likewise for the page size, which has a hundred distinct values. */
    it('serves every page size from one cached entry', async () => {
      await request(app.getHttpServer()).get('/services?limit=2').expect(200);
      const afterFirst = await redis.keys(`${CATALOGUE_CACHE_PREFIX}services:all`);

      for (const limit of [3, 7, 25, 99]) {
        await request(app.getHttpServer())
          .get(`/services?limit=${String(limit)}`)
          .expect(200);
      }

      const afterMany = await redis.keys(`${CATALOGUE_CACHE_PREFIX}services:*`);
      expect(afterFirst).toHaveLength(1);
      expect(afterMany).toHaveLength(1);
    });

    it('still pages correctly when the page is sliced out of a cached full page', async () => {
      const first = await request(app.getHttpServer()).get('/services?limit=3').expect(200);
      const firstBody = first.body as Page<ServiceBody>;
      expect(firstBody.items).toHaveLength(3);
      expect(firstBody.nextCursor).not.toBeNull();

      const second = await request(app.getHttpServer())
        .get(`/services?limit=3&cursor=${encodeURIComponent(String(firstBody.nextCursor))}`)
        .expect(200);
      const secondSlugs = (second.body as Page<ServiceBody>).items.map((item) => item.slug);

      expect(secondSlugs).not.toContain(firstBody.items[0]?.slug);
      expect(secondSlugs).not.toContain(firstBody.items[2]?.slug);
    });
  });

  describe('a deactivated category', () => {
    /**
     * An admin who switches a category off means "stop selling this". If the
     * services under it stayed orderable, the panel would be showing a
     * setting that changes nothing that matters. ADR-0020.
     */
    it('takes its services out of the list with it', async () => {
      const categories = await request(app.getHttpServer()).get('/services/categories').expect(200);
      const cleaning = (categories.body as Page<CategoryBody>).items.find(
        (item) => item.slug === 'cleaning',
      );

      await pool.query(`UPDATE service_categories SET is_active = false WHERE slug = 'cleaning'`);
      await clearCatalogueCache();

      const response = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const slugs = (response.body as Page<ServiceBody>).items.map((item) => item.slug);

      expect(slugs).not.toContain('apartment-cleaning');
      expect(slugs).not.toContain('window-cleaning');

      const filtered = await request(app.getHttpServer())
        .get(`/services?categoryId=${String(cleaning?.id)}`)
        .expect(200);
      expect((filtered.body as Page<ServiceBody>).items).toHaveLength(0);

      await pool.query(`UPDATE service_categories SET is_active = true WHERE slug = 'cleaning'`);
      await clearCatalogueCache();
    });

    it('makes its services 404 by id, not merely unlisted', async () => {
      const listed = await request(app.getHttpServer()).get('/services?limit=100').expect(200);
      const service = (listed.body as Page<ServiceBody>).items.find(
        (item) => item.slug === 'window-cleaning',
      );

      await pool.query(`UPDATE service_categories SET is_active = false WHERE slug = 'cleaning'`);
      await clearCatalogueCache();

      await request(app.getHttpServer())
        .get(`/services/${String(service?.id)}`)
        .expect(404);

      await pool.query(`UPDATE service_categories SET is_active = true WHERE slug = 'cleaning'`);
      await clearCatalogueCache();
    });
  });
});
