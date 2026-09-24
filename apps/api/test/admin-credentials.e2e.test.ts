import { randomUUID } from 'node:crypto';

import { ModulesContainer } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminSetupStart } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { loadAppConfig } from '../src/infra/config/load-app-config';
import { runMigrations } from '../src/infra/database/migrate';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { createRateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { createAdminAuthConfig } from '../src/modules/admin/admin.config';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import {
  AdminBootstrapRefusedError,
  parseAdminBootstrapArgs,
  runAdminBootstrap,
} from '../src/modules/admin/admin-bootstrap.cli';
import { ADMIN_PUBLIC_ROUTE } from '../src/modules/admin/admin-public.decorator';
import { AdminSetupService } from '../src/modules/admin/admin-setup.service';
import { verifyPassword } from '../src/modules/admin/credentials/password-hash';
import { base32Decode, hotp, totpStepAt } from '../src/modules/admin/credentials/totp';
import { PUBLIC_ADMIN_ROUTES } from './support/public-admin-routes';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Admin setup links, first credentials and the bootstrap command (issue #240,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 2–3), over real
 * HTTP against Postgres.
 */
describe('admin credentials and setup links (issue #240)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let admins: AdminRepository;
  let setup: AdminSetupService;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const PASSWORD = 'a long enough passphrase';

  function post(path: string) {
    return request(app.getHttpServer()).post(path);
  }

  function tokenOf(link: string): string {
    const token = new URL(link).hash.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return token;
  }

  async function invitedAdmin(): Promise<{ adminUserId: string; token: string }> {
    const admin = await admins.createAdmin({
      email: `invited-${randomUUID()}@tezusta.az`,
      displayName: 'Aysel',
      roles: ['support'],
    });
    const issued = await setup.issueInvitation(admin.id, null);
    return { adminUserId: admin.id, token: tokenOf(issued.link) };
  }

  async function start(token: string): Promise<AdminSetupStart> {
    const res = await post('/admin/auth/setup/start').send({ token });
    expect(res.status).toBe(200);
    return res.body as AdminSetupStart;
  }

  function codeFor(offer: AdminSetupStart, now: Date = new Date()): string {
    return hotp(base32Decode(offer.totpSecret), totpStepAt(now));
  }

  async function credentials(adminUserId: string) {
    const { rows } = await pool.query<{
      password_hash: string | null;
      totp_secret_encrypted: string | null;
      totp_enrolled_at: Date | null;
      last_totp_step: string | null;
    }>(
      `select password_hash, totp_secret_encrypted, totp_enrolled_at, last_totp_step
         from admin_users where id = $1`,
      [adminUserId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    process.env.DATABASE_URL = database.url;

    // The real policies, with one change: every request here comes from one
    // address, so the per-IP half of `admin-setup` would trip long before the
    // suite ends. The per-link half — the one under test — keeps its number.
    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `admin-credentials-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'admin-setup': { ...real.policies['admin-setup'], perIp: 1_000_000 },
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

  it('marks exactly the pinned routes as public admin routes', () => {
    const marked: string[] = [];
    for (const moduleRef of app.get(ModulesContainer).values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (controller === null) {
          continue;
        }
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (typeof handler !== 'function' || !Reflect.getMetadata(ADMIN_PUBLIC_ROUTE, handler)) {
            continue;
          }
          const base = String(Reflect.getMetadata(PATH_METADATA, controller));
          const path = String(Reflect.getMetadata(PATH_METADATA, handler));
          marked.push(`POST /${base}/${path}`);
        }
      }
    }
    expect(marked.sort()).toEqual([...PUBLIC_ADMIN_ROUTES].sort());
  });

  describe('a setup link, end to end', () => {
    it('offers a secret, then completes only with a code from it — and writes it all at once', async () => {
      const { adminUserId, token } = await invitedAdmin();
      const offer = await start(token);
      expect(offer.displayName).toBe('Aysel');
      expect(offer.otpauthUri.startsWith('otpauth://totp/TezUsta:')).toBe(true);

      // Nothing is written by `start`.
      expect((await credentials(adminUserId))?.password_hash).toBeNull();

      const res = await post('/admin/auth/setup/complete').send({
        token,
        password: PASSWORD,
        enrolment: offer.enrolment,
        code: codeFor(offer),
      });
      expect(res.status).toBe(204);

      const row = await credentials(adminUserId);
      expect(row?.totp_enrolled_at).not.toBeNull();
      expect(row?.last_totp_step).not.toBeNull();
      // Sealed, not the base32 an authenticator reads.
      expect(row?.totp_secret_encrypted).not.toContain(offer.totpSecret);
      expect(await verifyPassword(PASSWORD, row?.password_hash ?? '')).toBe(true);

      const audit = await pool.query<{ action: string }>(
        `select action from admin_audit_log where target_id = $1`,
        [adminUserId],
      );
      expect(audit.rows.map((r) => r.action)).toContain('admin.setup.complete');
    });

    it('refuses the same link a second time', async () => {
      const { token } = await invitedAdmin();
      const offer = await start(token);
      await post('/admin/auth/setup/complete')
        .send({ token, password: PASSWORD, enrolment: offer.enrolment, code: codeFor(offer) })
        .expect(204);

      const again = await post('/admin/auth/setup/start').send({ token });
      expect(again.status).toBe(400);
      expect((again.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    });

    it('lets two concurrent completions of one link succeed at most once', async () => {
      const { token } = await invitedAdmin();
      const offer = await start(token);
      const body = { token, password: PASSWORD, enrolment: offer.enrolment, code: codeFor(offer) };
      const results = await Promise.all([
        post('/admin/auth/setup/complete').send(body),
        post('/admin/auth/setup/complete').send(body),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    });
  });

  describe('a wrong code', () => {
    it('is ADMIN_TOTP_CODE_INVALID, writes nothing, and leaves the link usable', async () => {
      const { adminUserId, token } = await invitedAdmin();
      const offer = await start(token);
      const right = codeFor(offer);
      const wrong = right === '000000' ? '111111' : '000000';

      const res = await post('/admin/auth/setup/complete').send({
        token,
        password: PASSWORD,
        enrolment: offer.enrolment,
        code: wrong,
      });
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_TOTP_CODE_INVALID');
      expect((await credentials(adminUserId))?.password_hash).toBeNull();

      await post('/admin/auth/setup/complete')
        .send({ token, password: PASSWORD, enrolment: offer.enrolment, code: right })
        .expect(204);
    });
  });

  describe('links that are not usable, all answered alike', () => {
    async function expectInvalid(token: string): Promise<void> {
      const res = await post('/admin/auth/setup/start').send({ token });
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    }

    it('refuses a link that was never issued', async () => {
      await expectInvalid('A'.repeat(43));
    });

    it('refuses an expired link', async () => {
      const admin = await admins.createAdmin({
        email: `expired-${randomUUID()}@tezusta.az`,
        displayName: 'Expired',
        roles: ['support'],
      });
      const issued = await setup.issueInvitation(
        admin.id,
        null,
        new Date(Date.now() - 25 * 60 * 60 * 1000),
      );
      await expectInvalid(tokenOf(issued.link));
    });

    it('refuses a link replaced by a newer one', async () => {
      const { adminUserId, token } = await invitedAdmin();
      await setup.issueInvitation(adminUserId, null);
      await expectInvalid(token);
    });

    it('refuses a link for a disabled account', async () => {
      const { adminUserId, token } = await invitedAdmin();
      await pool.query(`update admin_users set status = 'disabled' where id = $1`, [adminUserId]);
      await expectInvalid(token);
    });

    it('refuses an enrolment offered for a different link', async () => {
      const first = await invitedAdmin();
      const second = await invitedAdmin();
      const offer = await start(first.token);
      const res = await post('/admin/auth/setup/complete').send({
        token: second.token,
        password: PASSWORD,
        enrolment: offer.enrolment,
        code: codeFor(offer),
      });
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    });
  });

  describe('validation', () => {
    it('refuses a password shorter than twelve characters', async () => {
      const { token } = await invitedAdmin();
      const offer = await start(token);
      const res = await post('/admin/auth/setup/complete').send({
        token,
        password: 'short',
        enrolment: offer.enrolment,
        code: codeFor(offer),
      });
      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('rate limiting', () => {
    it('stops the eleventh try on one link within fifteen minutes', async () => {
      const { token } = await invitedAdmin();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await post('/admin/auth/setup/start').send({ token }).expect(200);
      }
      const res = await post('/admin/auth/setup/start').send({ token });
      expect(res.status).toBe(429);
    });
  });

  describe('admin:bootstrap', () => {
    const config = (): ReturnType<typeof createAdminAuthConfig> =>
      createAdminAuthConfig(loadAppConfig());

    it('parses its two modes and refuses anything else', () => {
      expect(parseAdminBootstrapArgs(['--email', 'a@tezusta.az', '--name', 'A'])).toEqual({
        mode: 'create',
        email: 'a@tezusta.az',
        displayName: 'A',
      });
      expect(parseAdminBootstrapArgs(['--reissue', 'a@tezusta.az'])).toEqual({
        mode: 'reissue',
        email: 'a@tezusta.az',
      });
      expect(() => parseAdminBootstrapArgs(['--email', 'a@tezusta.az'])).toThrow();
      expect(() => parseAdminBootstrapArgs(['--reissue', 'a@tezusta.az', '--name', 'A'])).toThrow();
    });

    it('creates the first super_admin once, then refuses; --reissue resets them', async () => {
      // Its own database: "the first super_admin" is a whole-database fact.
      const own = await createThrowawayDatabase(parseEnv(process.env).database.url);
      await runMigrations(own.url);
      const ownPool = new Pool({ connectionString: own.url });
      try {
        const printed = await runAdminBootstrap(own.url, config(), {
          mode: 'create',
          email: 'Owner@TezUsta.az',
          displayName: 'Owner',
        });
        expect(printed).toMatch(/\/setup#[A-Za-z0-9_-]{43}\n/);

        const roles = await ownPool.query<{ role: string; email: string }>(
          `select r.role, u.email from admin_user_roles r join admin_users u on u.id = r.admin_user_id`,
        );
        expect(roles.rows).toEqual([{ role: 'super_admin', email: 'owner@tezusta.az' }]);

        await expect(
          runAdminBootstrap(own.url, config(), {
            mode: 'create',
            email: 'second@tezusta.az',
            displayName: 'Second',
          }),
        ).rejects.toBeInstanceOf(AdminBootstrapRefusedError);

        // Pretend setup completed, then recover.
        await ownPool.query(
          `update admin_users set password_hash = 'scrypt$x', totp_secret_encrypted = 'v1.x',
                  totp_enrolled_at = now()`,
        );
        const reissued = await runAdminBootstrap(own.url, config(), {
          mode: 'reissue',
          email: 'owner@tezusta.az',
        });
        expect(reissued).toMatch(/\/setup#[A-Za-z0-9_-]{43}\n/);
        const cleared = await ownPool.query<{ password_hash: string | null }>(
          `select password_hash from admin_users`,
        );
        expect(cleared.rows[0]?.password_hash).toBeNull();
        const live = await ownPool.query<{ count: number }>(
          `select count(*)::int as count from admin_invitations
            where used_at is null and revoked_at is null`,
        );
        expect(live.rows[0]?.count).toBe(1);

        await expect(
          runAdminBootstrap(own.url, config(), { mode: 'reissue', email: 'nobody@tezusta.az' }),
        ).rejects.toBeInstanceOf(AdminBootstrapRefusedError);
      } finally {
        await ownPool.end();
        await own.drop();
      }
    }, 60_000);
  });
});
