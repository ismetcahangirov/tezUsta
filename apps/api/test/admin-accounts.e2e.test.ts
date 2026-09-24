import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminAccount, AdminInvitationIssued, AdminMe, AdminRole } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Admin account management (issue #242,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 1, § 3).
 */
describe('admin account management (issue #242)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let admins: AdminRepository;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  interface TestAdmin {
    readonly id: string;
    readonly token: string;
  }

  async function newAdmin(roles: readonly AdminRole[]): Promise<TestAdmin> {
    const created = await admins.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Admin',
      roles,
    });
    const session = await app.get(AdminSessionService).start(created.id);
    return { id: created.id, token: session.accessToken };
  }

  function call(method: 'get' | 'post' | 'put', path: string, token: string) {
    return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${token}`);
  }

  function codeOf(res: request.Response): string {
    return (res.body as ErrorEnvelope).error.code;
  }

  async function auditFor(targetId: string) {
    const { rows } = await pool.query<{
      action: string;
      admin_user_id: string;
      before: unknown;
      after: unknown;
    }>(
      `select action, admin_user_id, before, after from admin_audit_log
        where target_id = $1 order by created_at, id`,
      [targetId],
    );
    return rows;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    admins = app.get(AdminRepository);
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
    const support = await newAdmin(['support']);
    expect((await call('get', '/admin/admins', support.token)).status).toBe(403);
  });

  describe('inviting', () => {
    it('creates the account and returns its setup link once', async () => {
      const boss = await newAdmin(['super_admin']);
      const email = `new-${randomUUID()}@tezusta.az`;
      const res = await call('post', '/admin/admins', boss.token).send({
        email: email.toUpperCase(),
        displayName: 'Leyla',
        roles: ['finance', 'support'],
      });
      expect(res.status).toBe(201);
      const issued = res.body as AdminInvitationIssued;
      expect(issued.setupLink).toMatch(/\/setup#[A-Za-z0-9_-]{43}$/);
      expect(issued.admin).toMatchObject({
        email,
        displayName: 'Leyla',
        status: 'active',
        roles: ['support', 'finance'],
        enrolled: false,
        invitationPending: true,
      });

      const list = (await call('get', '/admin/admins', boss.token)).body as AdminAccount[];
      const listed = list.find((account) => account.id === issued.admin.id);
      expect(listed).toBeDefined();
      expect(JSON.stringify(list)).not.toContain(issued.setupLink.split('#')[1]);

      const audit = await auditFor(issued.admin.id);
      expect(audit[0]).toMatchObject({ action: 'admin.invite', admin_user_id: boss.id });
    });

    it('refuses an email a live admin already has, and an invitation with no role', async () => {
      const boss = await newAdmin(['super_admin']);
      const email = `dup-${randomUUID()}@tezusta.az`;
      await call('post', '/admin/admins', boss.token)
        .send({ email, displayName: 'One', roles: ['support'] })
        .expect(201);
      const again = await call('post', '/admin/admins', boss.token).send({
        email,
        displayName: 'Two',
        roles: ['support'],
      });
      expect(again.status).toBe(409);
      expect(codeOf(again)).toBe('ADMIN_EMAIL_TAKEN');

      const noRole = await call('post', '/admin/admins', boss.token).send({
        email: `x-${randomUUID()}@tezusta.az`,
        displayName: 'X',
        roles: [],
      });
      expect(noRole.status).toBe(422);
    });
  });

  describe('disabling and enabling', () => {
    it('ends the target’s sessions at once and records before/after', async () => {
      const boss = await newAdmin(['super_admin']);
      const target = await newAdmin(['support']);
      expect((await call('get', '/admin/me', target.token)).status).toBe(200);

      const res = await call('post', `/admin/admins/${target.id}/disable`, boss.token).send({
        reason: 'Left the company.',
      });
      expect(res.status).toBe(200);
      expect((res.body as AdminAccount).status).toBe('disabled');
      expect((await call('get', '/admin/me', target.token)).status).toBe(401);

      const enabled = await call('post', `/admin/admins/${target.id}/enable`, boss.token).send({
        reason: 'Came back.',
      });
      expect((enabled.body as AdminAccount).status).toBe('active');

      const actions = (await auditFor(target.id)).map((row) => [row.action, row.after]);
      expect(actions).toEqual([
        ['admin.disable', { status: 'disabled' }],
        ['admin.enable', { status: 'active' }],
      ]);
    });

    it('refuses to act on the caller’s own account', async () => {
      const boss = await newAdmin(['super_admin']);
      const res = await call('post', `/admin/admins/${boss.id}/disable`, boss.token).send({
        reason: 'Oops.',
      });
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('ADMIN_SELF_ACTION_REFUSED');
    });

    it('answers 404 for an admin that does not exist', async () => {
      const boss = await newAdmin(['super_admin']);
      const res = await call('post', `/admin/admins/${randomUUID()}/disable`, boss.token).send({
        reason: 'Nobody.',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('roles', () => {
    it('replaces the roles, records before/after, and takes effect on the next request', async () => {
      const boss = await newAdmin(['super_admin']);
      const target = await newAdmin(['support']);
      const res = await call('put', `/admin/admins/${target.id}/roles`, boss.token).send({
        roles: ['moderator'],
        reason: 'Moved to verification.',
      });
      expect(res.status).toBe(200);
      expect((res.body as AdminAccount).roles).toEqual(['moderator']);

      const me = (await call('get', '/admin/me', target.token)).body as AdminMe;
      expect(me.permissions).toContain('masters.review');
      expect(me.permissions).not.toContain('orders.override');

      const [row] = await auditFor(target.id);
      expect(row).toMatchObject({
        action: 'admin.roles.set',
        before: { roles: ['support'] },
        after: { roles: ['moderator'] },
      });
    });
  });

  describe('second-factor reset', () => {
    it('clears the credential, ends sessions and returns a new link', async () => {
      const boss = await newAdmin(['super_admin']);
      const target = await newAdmin(['support']);
      await pool.query(
        `update admin_users set password_hash = 'scrypt$x', totp_secret_encrypted = 'v1.x',
                totp_enrolled_at = now() where id = $1`,
        [target.id],
      );

      const res = await call(
        'post',
        `/admin/admins/${target.id}/reset-second-factor`,
        boss.token,
      ).send({ reason: 'Lost phone.' });
      expect(res.status).toBe(200);
      const issued = res.body as AdminInvitationIssued;
      expect(issued.setupLink).toMatch(/\/setup#/);
      expect(issued.admin).toMatchObject({ enrolled: false, invitationPending: true });
      expect((await call('get', '/admin/me', target.token)).status).toBe(401);
    });
  });

  describe('the last super_admin', () => {
    it('survives two super_admins demoting each other at the same moment', async () => {
      const first = await newAdmin(['super_admin']);
      const second = await newAdmin(['super_admin']);
      // Leave exactly these two active super_admins in this database.
      await pool.query(
        `update admin_users set status = 'disabled'
          where id not in ($1, $2)
            and id in (select admin_user_id from admin_user_roles where role = 'super_admin')`,
        [first.id, second.id],
      );

      const results = await Promise.all([
        call('put', `/admin/admins/${second.id}/roles`, first.token).send({
          roles: ['support'],
          reason: 'Race.',
        }),
        call('put', `/admin/admins/${first.id}/roles`, second.token).send({
          roles: ['support'],
          reason: 'Race.',
        }),
      ]);
      const statuses = results.map((res) => res.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);

      const { rows } = await pool.query<{ count: number }>(
        `select count(*)::int as count from admin_user_roles r
           join admin_users u on u.id = r.admin_user_id
          where r.role = 'super_admin' and u.status = 'active'`,
      );
      expect(rows[0]?.count).toBe(1);
    });
  });
});
