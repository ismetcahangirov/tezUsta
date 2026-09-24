import { randomUUID } from 'node:crypto';

import { PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminMe, AdminRole } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { ADMIN_PERMISSION_KEY } from '../src/modules/admin/admin-permission.decorator';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Granular admin permissions (issue #239,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 1), over real
 * HTTP against the whole application.
 *
 * Two walks of the live application prove "deny by default": every admin
 * handler Nest registered carries a declaration, and an admin holding no role
 * is refused on every admin route except `GET /admin/me`. A new admin
 * endpoint that forgets its permission fails the first; one that declares a
 * permission nobody meant to hand out still fails the second for a role-less
 * admin, which is the case that matters.
 */
describe('admin permissions (issue #239)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let adminRoutes: { method: string; url: string }[];
  const originalDatabaseUrl = process.env.DATABASE_URL;

  async function newAdmin(
    roles: readonly AdminRole[],
  ): Promise<{ adminUserId: string; accessToken: string }> {
    const created = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
      roles,
    });
    const session = await app.get(AdminSessionService).start(created.id);
    return { adminUserId: created.id, accessToken: session.accessToken };
  }

  function call(method: string, path: string, accessToken: string) {
    const agent = request(app.getHttpServer());
    const pending = (() => {
      switch (method.toUpperCase()) {
        case 'GET':
          return agent.get(path);
        case 'POST':
          return agent.post(path);
        case 'PUT':
          return agent.put(path);
        case 'PATCH':
          return agent.patch(path);
        case 'DELETE':
          return agent.delete(path);
        default:
          throw new Error(`Unsupported method "${method}" on the admin route table.`);
      }
    })();
    return pending.set('authorization', `Bearer ${accessToken}`);
  }

  function fill(url: string): string {
    return url.replace(/:([A-Za-z0-9_]+)/g, () => randomUUID());
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const adapter = new FastifyAdapter();
    const discovered: { method: string; url: string }[] = [];
    adapter.getInstance().addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        discovered.push({ method, url: route.url });
      }
    });
    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const seen = new Set<string>();
    adminRoutes = discovered.filter((route) => {
      const key = `${route.method} ${route.url}`;
      const isAdmin = route.url === '/admin' || route.url.startsWith('/admin/');
      if (!isAdmin || route.method === 'HEAD' || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    pool = new Pool({ connectionString: database.url });
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

  describe('deny by default', () => {
    it('finds every admin handler declaring a permission', () => {
      const undeclared: string[] = [];
      let inspected = 0;
      for (const moduleRef of app.get(ModulesContainer).values()) {
        for (const wrapper of moduleRef.controllers.values()) {
          const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
          if (controller === null) {
            continue;
          }
          const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
          if (typeof base !== 'string' || !/^\/?admin(\/|$)/.test(base)) {
            continue;
          }
          const prototype = controller.prototype as Record<string, unknown>;
          for (const name of Object.getOwnPropertyNames(prototype)) {
            const handler = prototype[name];
            if (name === 'constructor' || typeof handler !== 'function') {
              continue;
            }
            if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) {
              continue;
            }
            inspected += 1;
            const declared =
              Reflect.getMetadata(ADMIN_PERMISSION_KEY, handler) ??
              Reflect.getMetadata(ADMIN_PERMISSION_KEY, controller);
            if (declared === undefined) {
              undeclared.push(`${controller.name}.${name}`);
            }
          }
        }
      }
      // A control on the walk itself: zero inspected would pass vacuously.
      expect(inspected).toBeGreaterThanOrEqual(15);
      expect(undeclared).toEqual([]);
    });

    it('refuses an admin with no role on every admin route except GET /admin/me', async () => {
      expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
      const roleless = await newAdmin([]);
      for (const route of adminRoutes) {
        const res = await call(route.method, fill(route.url), roleless.accessToken).send({});
        const expected = route.method === 'GET' && route.url === '/admin/me' ? 200 : 403;
        expect(res.status, `${route.method} ${route.url}`).toBe(expected);
      }
    });
  });

  describe('role boundaries', () => {
    it('refuses master verification to support', async () => {
      const support = await newAdmin(['support']);
      const res = await call(
        'POST',
        `/admin/masters/${randomUUID()}/verify`,
        support.accessToken,
      ).send({ reason: 'Sənədlər qaydasındadır.' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it('lets a moderator read masters', async () => {
      const moderator = await newAdmin(['moderator']);
      const res = await call('GET', '/admin/masters', moderator.accessToken);
      expect(res.status).toBe(200);
    });

    it('refuses an order override to a moderator', async () => {
      const moderator = await newAdmin(['moderator']);
      const res = await call(
        'POST',
        `/admin/orders/${randomUUID()}/transitions`,
        moderator.accessToken,
      ).send({ to: 'SEARCHING', reason: 'Usta cavab vermir.' });
      expect(res.status).toBe(403);
    });

    it('refuses a live-order override to finance, which may only close disputes', async () => {
      const finance = await newAdmin(['finance']);
      const override = await call(
        'POST',
        `/admin/orders/${randomUUID()}/transitions`,
        finance.accessToken,
      ).send({ to: 'CANCELLED', reason: 'Müştəri zəng etdi.' });
      expect(override.status).toBe(403);

      // Past the permission check — the order does not exist, so it is a 404,
      // which is what proves the refusal above was about the permission.
      const resolve = await call(
        'POST',
        `/admin/orders/${randomUUID()}/transitions`,
        finance.accessToken,
      ).send({ to: 'RESOLVED', reason: 'Tərəflər razılaşdı.' });
      expect(resolve.status).toBe(404);
    });

    it('refuses the refund outcome to support', async () => {
      const support = await newAdmin(['support']);
      const res = await call(
        'POST',
        `/admin/orders/${randomUUID()}/transitions`,
        support.accessToken,
      ).send({ to: 'REFUNDED', reason: 'Pul qaytarıldı.' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/me', () => {
    it('returns the roles and their union of permissions', async () => {
      const admin = await newAdmin(['support', 'finance']);
      const res = await call('GET', '/admin/me', admin.accessToken);
      expect(res.status).toBe(200);
      const me = res.body as AdminMe;
      expect(me.id).toBe(admin.adminUserId);
      expect(me.roles).toEqual(['support', 'finance']);
      expect(me.permissions).toContain('disputes.refund');
      expect(me.permissions).toContain('pii.read');
      expect(me.permissions).not.toContain('admins.manage');
    });

    it('reflects a role change on the very next request, not at token expiry', async () => {
      const admin = await newAdmin(['moderator']);
      expect((await call('GET', '/admin/masters', admin.accessToken)).status).toBe(200);

      await pool.query(`delete from admin_user_roles where admin_user_id = $1`, [
        admin.adminUserId,
      ]);

      expect((await call('GET', '/admin/masters', admin.accessToken)).status).toBe(403);
      const me = (await call('GET', '/admin/me', admin.accessToken)).body as AdminMe;
      expect(me.roles).toEqual([]);
      expect(me.permissions).toEqual([]);
    });
  });
});
