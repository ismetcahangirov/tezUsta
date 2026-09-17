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
});
