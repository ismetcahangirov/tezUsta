import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminCatalogue,
  AdminCatalogueCategory,
  AdminCatalogueService,
  AdminRole,
  Service,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Editing the catalogue without an app release (issue #244, EPIC 13
 * acceptance criterion 6), over real HTTP against Postgres and Redis.
 */
describe('admin catalogue management (issue #244)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let token: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  async function adminToken(roles: readonly AdminRole[]): Promise<string> {
    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Admin',
      roles,
    });
    return (await app.get(AdminSessionService).start(created.id)).accessToken;
  }

  function call(method: 'get' | 'post' | 'patch' | 'put', path: string, bearer = token) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${bearer}`);
  }

  function slug(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  async function newCategory(): Promise<AdminCatalogueCategory> {
    const res = await call('post', '/admin/catalogue/categories').send({
      slug: slug('cat'),
      name: { az: 'Kondisioner', en: 'Air conditioning' },
    });
    expect(res.status).toBe(201);
    return res.body as AdminCatalogueCategory;
  }

  async function newService(categoryId: string): Promise<AdminCatalogueService> {
    const res = await call('post', '/admin/catalogue/services').send({
      categoryId,
      slug: slug('svc'),
      name: { az: 'Kondisioner təmizlənməsi' },
      pricingKind: 'fixed',
      basePriceMinor: 4500,
    });
    expect(res.status).toBe(201);
    return res.body as AdminCatalogueService;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    token = await adminToken(['super_admin']);
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

  it('is for super_admin only', async () => {
    const support = await adminToken(['support']);
    expect((await call('get', '/admin/catalogue', support)).status).toBe(403);
  });

  it('reads the whole catalogue, every language, inactive rows included', async () => {
    await pool.query(
      `update services set is_active = false
        where id = (select id from services order by id limit 1)`,
    );
    const res = await call('get', '/admin/catalogue');
    expect(res.status).toBe(200);
    const catalogue = res.body as AdminCatalogue;
    const all = catalogue.categories.flatMap((category) => category.services);
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((service) => !service.isActive)).toBe(true);
    expect(typeof all[0]?.name.az).toBe('string');
  });

  it('creates a category and a service that the public catalogue serves at once', async () => {
    const category = await newCategory();
    const service = await newService(category.id);
    expect(service).toMatchObject({ pricingKind: 'fixed', basePriceMinor: 4500, isActive: true });

    const publicRes = await request(app.getHttpServer()).get(`/services/${service.id}`);
    expect(publicRes.status).toBe(200);
    expect((publicRes.body as Service).slug).toBe(service.slug);
  });

  it('hides a deactivated service from the public catalogue on the next read, not after the TTL', async () => {
    const service = await newService((await newCategory()).id);
    // Warm the cache first, so the 404 below proves invalidation.
    await request(app.getHttpServer()).get(`/services/${service.id}`).expect(200);

    const res = await call('patch', `/admin/catalogue/services/${service.id}`).send({
      isActive: false,
    });
    expect(res.status).toBe(200);
    await request(app.getHttpServer()).get(`/services/${service.id}`).expect(404);

    const { rows } = await pool.query<{ action: string; before: unknown; after: unknown }>(
      `select action, before, after from admin_audit_log where target_id = $1 order by created_at`,
      [service.id],
    );
    expect(rows.at(-1)).toEqual({
      action: 'catalogue.service.update',
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  describe('the pricing shape', () => {
    it('refuses a fixed service with no price and an inspection service with one', async () => {
      const category = await newCategory();
      const fixed = await call('post', '/admin/catalogue/services').send({
        categoryId: category.id,
        slug: slug('svc'),
        name: { az: 'Kran' },
        pricingKind: 'fixed',
      });
      expect(fixed.status).toBe(422);
      const inspection = await call('post', '/admin/catalogue/services').send({
        categoryId: category.id,
        slug: slug('svc'),
        name: { az: 'Kran' },
        pricingKind: 'inspection',
        basePriceMinor: 1000,
      });
      expect(inspection.status).toBe(422);
    });

    it('clears the price when a service switches to inspection, and needs one to switch back', async () => {
      const service = await newService((await newCategory()).id);
      const toInspection = await call('patch', `/admin/catalogue/services/${service.id}`).send({
        pricingKind: 'inspection',
      });
      expect((toInspection.body as AdminCatalogueService).basePriceMinor).toBeNull();

      const backWithout = await call('patch', `/admin/catalogue/services/${service.id}`).send({
        pricingKind: 'fixed',
      });
      expect(backWithout.status).toBe(422);

      const backWith = await call('patch', `/admin/catalogue/services/${service.id}`).send({
        pricingKind: 'fixed',
        basePriceMinor: 3000,
      });
      expect((backWith.body as AdminCatalogueService).basePriceMinor).toBe(3000);
    });
  });

  describe('validation', () => {
    it('refuses a duplicate slug with its own code', async () => {
      const category = await newCategory();
      const res = await call('post', '/admin/catalogue/categories').send({
        slug: category.slug,
        name: { az: 'Təkrar' },
      });
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CATALOGUE_SLUG_TAKEN');
    });

    it('refuses a malformed slug and a name without Azerbaijani', async () => {
      const badSlug = await call('post', '/admin/catalogue/categories').send({
        slug: 'Not A Slug',
        name: { az: 'Ad' },
      });
      expect(badSlug.status).toBe(422);
      const noAz = await call('post', '/admin/catalogue/categories').send({
        slug: slug('cat'),
        name: { en: 'Only English' },
      });
      expect(noAz.status).toBe(422);
    });

    it('answers 404 for a service in a category that does not exist', async () => {
      const res = await call('post', '/admin/catalogue/services').send({
        categoryId: randomUUID(),
        slug: slug('svc'),
        name: { az: 'Heç nə' },
        pricingKind: 'inspection',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('ordering', () => {
    it('reorders a category’s services and refuses a list that is not a permutation', async () => {
      const category = await newCategory();
      const first = await newService(category.id);
      const second = await newService(category.id);

      const wrong = await call(
        'put',
        `/admin/catalogue/categories/${category.id}/services/order`,
      ).send({ ids: [first.id] });
      expect(wrong.status).toBe(422);

      const res = await call(
        'put',
        `/admin/catalogue/categories/${category.id}/services/order`,
      ).send({ ids: [second.id, first.id] });
      expect(res.status).toBe(200);
      const updated = (res.body as AdminCatalogue).categories.find((c) => c.id === category.id);
      expect(updated?.services.map((service) => service.id)).toEqual([second.id, first.id]);
    });
  });
});
