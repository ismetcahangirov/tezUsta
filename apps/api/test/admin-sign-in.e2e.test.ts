import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminMe, AdminRole } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { loadAppConfig } from '../src/infra/config/load-app-config';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { createRateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSetupService } from '../src/modules/admin/admin-setup.service';
import {
  AdminSignInFailedError,
  AdminSignInService,
} from '../src/modules/admin/admin-sign-in.service';
import { base32Decode, hotp, totpStepAt } from '../src/modules/admin/credentials/totp';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Admin sign-in, refresh rotation and sign-out over httpOnly cookies
 * (issue #241, [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 4),
 * over real HTTP against Postgres.
 */
describe('admin sign-in over cookies (issue #241)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let admins: AdminRepository;
  let setup: AdminSetupService;
  let signIn: AdminSignInService;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const PASSWORD = 'correct horse battery staple';
  const CSRF = { 'x-tezusta-admin': '1' } as const;

  interface EnrolledAdmin {
    readonly id: string;
    readonly email: string;
    readonly secret: Buffer;
  }

  /** An admin who has completed setup, and the authenticator secret they hold. */
  async function enrolledAdmin(roles: readonly AdminRole[] = ['support']): Promise<EnrolledAdmin> {
    const email = `admin-${randomUUID()}@tezusta.az`;
    const created = await admins.createAdmin({ email, displayName: 'Aysel', roles });
    const issued = await setup.issueInvitation(created.id, null);
    const token = new URL(issued.link).hash.slice(1);
    const offer = await setup.start(token);
    const secret = base32Decode(offer.totpSecret);
    // Enrolled with the previous step, so a sign-in in this step is newer.
    const past = new Date(Date.now() - 30_000);
    await setup.complete(
      {
        token,
        password: PASSWORD,
        enrolment: offer.enrolment,
        code: hotp(secret, totpStepAt(past)),
      },
      past,
    );
    return { id: created.id, email, secret };
  }

  function codeFor(admin: EnrolledAdmin, stepOffset = 0): string {
    return hotp(admin.secret, totpStepAt(new Date()) + stepOffset);
  }

  function cookiesFrom(res: request.Response): Record<string, string> {
    const raw = res.headers['set-cookie'] as unknown;
    const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
    const jar: Record<string, string> = {};
    for (const line of list) {
      const [pair] = line.split(';');
      const [name, ...value] = (pair ?? '').split('=');
      if (name !== undefined) {
        jar[name.trim()] = value.join('=');
      }
    }
    return jar;
  }

  function cookieHeader(jar: Record<string, string>): string {
    return Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  async function signInOver(admin: EnrolledAdmin, stepOffset = 0) {
    return request(app.getHttpServer())
      .post('/admin/auth/sign-in')
      .set(CSRF)
      .send({ email: admin.email, password: PASSWORD, code: codeFor(admin, stepOffset) });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    process.env.DATABASE_URL = database.url;

    // Every request here comes from one address; the per-IP half of the admin
    // budgets would trip long before the suite ends. The per-account halves —
    // the ones under test — keep their real numbers.
    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `admin-sign-in-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'admin-sign-in': { ...real.policies['admin-sign-in'], perIp: 1_000_000 },
        refresh: { ...real.policies.refresh, perIp: 1_000_000 },
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(rateLimits)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    admins = app.get(AdminRepository);
    setup = app.get(AdminSetupService);
    signIn = app.get(AdminSignInService);
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

  describe('signing in', () => {
    it('answers AdminMe and sets two hardened cookies that authenticate the panel', async () => {
      const admin = await enrolledAdmin(['moderator']);
      const res = await signInOver(admin);
      expect(res.status).toBe(200);
      expect((res.body as AdminMe).roles).toEqual(['moderator']);

      const lines = res.headers['set-cookie'] as unknown as string[];
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Strict');
        expect(line).toContain('Path=/');
        expect(line).toContain('Secure');
      }

      const jar = cookiesFrom(res);
      const me = await request(app.getHttpServer())
        .get('/admin/me')
        .set(CSRF)
        .set('cookie', cookieHeader(jar));
      expect(me.status).toBe(200);
      expect((me.body as AdminMe).id).toBe(admin.id);

      const audit = await pool.query<{ action: string }>(
        `select action from admin_audit_log where target_id = $1 and action = 'admin.sign_in'`,
        [admin.id],
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('refuses the access cookie without the CSRF header', async () => {
      const admin = await enrolledAdmin();
      const jar = cookiesFrom(await signInOver(admin));
      const me = await request(app.getHttpServer())
        .get('/admin/me')
        .set('cookie', cookieHeader(jar));
      expect(me.status).toBe(401);
    });

    it('refuses a sign-in form posted without the CSRF header', async () => {
      const admin = await enrolledAdmin();
      const res = await request(app.getHttpServer())
        .post('/admin/auth/sign-in')
        .send({ email: admin.email, password: PASSWORD, code: codeFor(admin) });
      expect(res.status).toBe(403);
    });

    it('answers a wrong password, a wrong code and an unknown email identically', async () => {
      const admin = await enrolledAdmin();
      const right = codeFor(admin);
      const wrongCode = right === '000000' ? '111111' : '000000';
      const attempts = [
        { email: admin.email, password: 'not the password at all', code: right },
        { email: admin.email, password: PASSWORD, code: wrongCode },
        { email: `nobody-${randomUUID()}@tezusta.az`, password: PASSWORD, code: right },
      ];
      const bodies: unknown[] = [];
      for (const body of attempts) {
        const res = await request(app.getHttpServer())
          .post('/admin/auth/sign-in')
          .set(CSRF)
          .send(body);
        expect(res.status).toBe(401);
        expect(res.headers['set-cookie']).toBeUndefined();
        const envelope = res.body as ErrorEnvelope;
        bodies.push({ code: envelope.error.code, message: envelope.error.message });
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    });

    it('never accepts one code twice', async () => {
      const admin = await enrolledAdmin();
      // One code, computed once: recomputing it could cross a 30-second
      // boundary and quietly test a different code.
      const step = totpStepAt(new Date());
      const post = (code: string) =>
        request(app.getHttpServer())
          .post('/admin/auth/sign-in')
          .set(CSRF)
          .send({ email: admin.email, password: PASSWORD, code });
      expect((await post(hotp(admin.secret, step))).status).toBe(200);
      expect((await post(hotp(admin.secret, step))).status).toBe(401);
      // A later step is still good.
      expect((await post(hotp(admin.secret, step + 1))).status).toBe(200);
    });

    it('refuses a disabled account and one that never finished setup', async () => {
      const disabled = await enrolledAdmin();
      await pool.query(`update admin_users set status = 'disabled' where id = $1`, [disabled.id]);
      expect((await signInOver(disabled)).status).toBe(401);

      const invited = await admins.createAdmin({
        email: `invited-${randomUUID()}@tezusta.az`,
        displayName: 'Invited',
        roles: ['support'],
      });
      const res = await request(app.getHttpServer())
        .post('/admin/auth/sign-in')
        .set(CSRF)
        .send({ email: invited.email, password: PASSWORD, code: '123456' });
      expect(res.status).toBe(401);
    });

    it('locks an account out after five tries in fifteen minutes', async () => {
      const admin = await enrolledAdmin();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post('/admin/auth/sign-in')
          .set(CSRF)
          .send({ email: admin.email, password: 'wrong wrong wrong', code: '000000' })
          .expect(401);
      }
      expect((await signInOver(admin)).status).toBe(429);
    });
  });

  describe('refresh and sign-out', () => {
    it('rotates the refresh cookie; a second tab racing it gets success and no cookies', async () => {
      const admin = await enrolledAdmin();
      const first = cookiesFrom(await signInOver(admin));

      const rotated = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set(CSRF)
        .set('cookie', cookieHeader(first));
      expect(rotated.status).toBe(200);
      const second = cookiesFrom(rotated);
      expect(second.tz_admin_rt).toBeDefined();
      expect(second.tz_admin_rt).not.toBe(first.tz_admin_rt);

      const racing = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set(CSRF)
        .set('cookie', cookieHeader(first));
      expect(racing.status).toBe(200);
      expect(racing.headers['set-cookie']).toBeUndefined();
    });

    it('revokes the whole session when a rotated token comes back after the grace window', async () => {
      const admin = await enrolledAdmin();
      const jar = cookiesFrom(await signInOver(admin));
      const old = jar.tz_admin_rt ?? '';

      await signIn.refresh(old);
      await expect(signIn.refresh(old, new Date(Date.now() + 60_000))).rejects.toBeInstanceOf(
        AdminSignInFailedError,
      );

      const me = await request(app.getHttpServer())
        .get('/admin/me')
        .set(CSRF)
        .set('cookie', cookieHeader(jar));
      expect(me.status).toBe(401);
    });

    it('refuses a refresh after thirty idle minutes', async () => {
      const admin = await enrolledAdmin();
      const jar = cookiesFrom(await signInOver(admin));
      await expect(
        signIn.refresh(jar.tz_admin_rt ?? '', new Date(Date.now() + 31 * 60_000)),
      ).rejects.toBeInstanceOf(AdminSignInFailedError);
    });

    it('signs out: the session ends and both cookies are cleared', async () => {
      const admin = await enrolledAdmin();
      const jar = cookiesFrom(await signInOver(admin));

      const out = await request(app.getHttpServer())
        .post('/admin/auth/sign-out')
        .set(CSRF)
        .set('cookie', cookieHeader(jar));
      expect(out.status).toBe(204);
      const cleared = out.headers['set-cookie'] as unknown as string[];
      expect(cleared.every((line) => line.includes('Max-Age=0'))).toBe(true);

      const me = await request(app.getHttpServer())
        .get('/admin/me')
        .set(CSRF)
        .set('cookie', cookieHeader(jar));
      expect(me.status).toBe(401);
      const refresh = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set(CSRF)
        .set('cookie', cookieHeader(jar));
      expect(refresh.status).toBe(401);
    });
  });
});
