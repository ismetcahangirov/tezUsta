import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminInvitationIssued, AdminPasswordResetStart, AdminRole } from '@tezusta/types';
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
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { AdminSetupService } from '../src/modules/admin/admin-setup.service';
import { base32Decode, hotp, totpStepAt } from '../src/modules/admin/credentials/totp';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * An admin changing their own password, and a super_admin issuing a
 * single-use password-reset link (#329), over real HTTP against Postgres.
 */
// Every attempt verifies or writes a scrypt hash; under a full verify that is
// slow, the same reason `admin-sign-in.e2e.test.ts` gives.
describe('admin password change and reset (#329)', { timeout: 30_000 }, () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let admins: AdminRepository;
  let setup: AdminSetupService;
  let sessions: AdminSessionService;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const PASSWORD = 'correct horse battery staple';
  const NEW_PASSWORD = 'a different long passphrase';
  const CSRF = { 'x-tezusta-admin': '1' } as const;

  interface EnrolledAdmin {
    readonly id: string;
    readonly email: string;
    readonly secret: Buffer;
  }

  /** An admin who completed setup one step ago, so the current step is newer. */
  async function enrolledAdmin(roles: readonly AdminRole[] = ['support']): Promise<EnrolledAdmin> {
    const email = `admin-${randomUUID()}@tezusta.az`;
    const created = await admins.createAdmin({ email, displayName: 'Aysel', roles });
    const issued = await setup.issueInvitation(created.id, null);
    const token = new URL(issued.link).hash.slice(1);
    const offer = await setup.start(token);
    if (offer.purpose !== 'setup') {
      throw new Error('An invitation offers an authenticator.');
    }
    const secret = base32Decode(offer.totpSecret);
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

  async function bearer(adminUserId: string): Promise<{ token: string; sessionId: string }> {
    const started = await sessions.start(adminUserId);
    return { token: started.accessToken, sessionId: started.sessionId };
  }

  function as(token: string) {
    return {
      get: (path: string) =>
        request(app.getHttpServer()).get(path).set('authorization', `Bearer ${token}`),
      post: (path: string) =>
        request(app.getHttpServer()).post(path).set('authorization', `Bearer ${token}`),
    };
  }

  function signInOver(email: string, password: string, code: string) {
    return request(app.getHttpServer())
      .post('/admin/auth/sign-in')
      .set(CSRF)
      .send({ email, password, code });
  }

  async function revokedSessions(adminUserId: string): Promise<Record<string, boolean>> {
    const { rows } = await pool.query<{ id: string; revoked: boolean }>(
      `select id, revoked_at is not null as revoked from admin_sessions where admin_user_id = $1`,
      [adminUserId],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.revoked]));
  }

  async function auditOf(targetId: string): Promise<
    {
      action: string;
      admin_user_id: string;
      reason: string | null;
      before: unknown;
      after: unknown;
    }[]
  > {
    const { rows } = await pool.query(
      `select action, admin_user_id, reason, before, after from admin_audit_log
       where target_id = $1 and action like 'admin.password.%' order by created_at, id`,
      [targetId],
    );
    return rows as never;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    process.env.DATABASE_URL = database.url;

    // One address makes every request; the per-account halves — the lockout
    // under test — keep their real numbers.
    const real = createRateLimitConfig(loadAppConfig());
    const rateLimits: RateLimitConfig = {
      keySecret: `admin-passwords-e2e-${randomUUID()}`,
      policies: {
        ...real.policies,
        'admin-sign-in': { ...real.policies['admin-sign-in'], perIp: 1_000_000 },
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
    sessions = app.get(AdminSessionService);
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

  describe('changing your own password', () => {
    it('needs the current password and a code, ends the other sessions, and is audited', async () => {
      const admin = await enrolledAdmin();
      const here = await bearer(admin.id);
      const elsewhere = await bearer(admin.id);

      const res = await as(here.token)
        .post('/admin/me/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, code: codeFor(admin) });
      expect(res.status).toBe(204);

      expect(await revokedSessions(admin.id)).toEqual({
        [here.sessionId]: false,
        [elsewhere.sessionId]: true,
      });
      expect((await as(here.token).get('/admin/me')).status).toBe(200);
      expect((await as(elsewhere.token).get('/admin/me')).status).toBe(401);

      // The old password no longer signs in; the new one does.
      expect((await signInOver(admin.email, PASSWORD, codeFor(admin, 1))).status).toBe(401);
      expect((await signInOver(admin.email, NEW_PASSWORD, codeFor(admin, 1))).status).toBe(200);

      const audit = await auditOf(admin.id);
      expect(audit).toEqual([
        {
          action: 'admin.password.change',
          admin_user_id: admin.id,
          reason: null,
          before: null,
          after: null,
        },
      ]);
    });

    it.each([
      ['a wrong current password', { currentPassword: 'not the password at all' }],
      ['a wrong code', { code: '000000' }],
    ])('refuses %s with one answer for both, and changes nothing', async (_label, override) => {
      const admin = await enrolledAdmin();
      const here = await bearer(admin.id);
      const res = await as(here.token)
        .post('/admin/me/password')
        .send({
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          code: codeFor(admin),
          ...override,
        });
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_CREDENTIALS_INVALID');
      expect((await signInOver(admin.email, PASSWORD, codeFor(admin, 1))).status).toBe(200);
      expect(await auditOf(admin.id)).toEqual([]);
    });

    it('refuses a weak new password before checking anything', async () => {
      const admin = await enrolledAdmin();
      const here = await bearer(admin.id);
      const res = await as(here.token)
        .post('/admin/me/password')
        .send({ currentPassword: PASSWORD, newPassword: 'short', code: codeFor(admin) });
      expect(res.status).toBe(422);
    });

    it('spends the sign-in lockout: five wrong attempts lock the sign-in form too', async () => {
      const admin = await enrolledAdmin();
      const here = await bearer(admin.id);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await as(here.token)
          .post('/admin/me/password')
          .send({
            currentPassword: `wrong guess ${String(attempt)}`,
            newPassword: NEW_PASSWORD,
            code: '000000',
          });
        expect(res.status).toBe(400);
      }
      const locked = await as(here.token)
        .post('/admin/me/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, code: codeFor(admin) });
      expect(locked.status).toBe(429);
      expect((await signInOver(admin.email, PASSWORD, codeFor(admin))).status).toBe(429);
    });
  });

  describe('a super_admin resetting a colleague', () => {
    async function superAdmin(): Promise<{ id: string; token: string }> {
      const created = await admins.createAdmin({
        email: `super-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['super_admin'],
      });
      return { id: created.id, token: (await bearer(created.id)).token };
    }

    it('issues a one-time link: the old password stops, the colleague sets a new one with their code', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const openSession = await bearer(colleague.id);

      const res = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({ reason: 'Forgot it after leave.' });
      expect(res.status).toBe(200);
      const issued = res.body as AdminInvitationIssued;
      const token = new URL(issued.setupLink).hash.slice(1);

      // At once: the old password does not sign in, and the open session is dead.
      expect((await signInOver(colleague.email, PASSWORD, codeFor(colleague))).status).toBe(401);
      expect((await as(openSession.token).get('/admin/me')).status).toBe(401);

      // The link asks for a password and the code of the authenticator they have.
      const started = await request(app.getHttpServer())
        .post('/admin/auth/setup/start')
        .send({ token });
      expect(started.status).toBe(200);
      expect(started.body).toEqual<AdminPasswordResetStart>({
        purpose: 'password_reset',
        email: colleague.email,
        displayName: 'Aysel',
      });

      const wrongCode = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: '000000' });
      expect(wrongCode.status).toBe(400);
      expect((wrongCode.body as ErrorEnvelope).error.code).toBe('ADMIN_TOTP_CODE_INVALID');

      const completed = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: codeFor(colleague) });
      expect(completed.status).toBe(204);

      expect((await signInOver(colleague.email, NEW_PASSWORD, codeFor(colleague, 1))).status).toBe(
        200,
      );

      // The link works once.
      const replay = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: 'yet another long passphrase', code: codeFor(colleague, 1) });
      expect(replay.status).toBe(400);
      expect((replay.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');

      // Every step audited, with no secret in it.
      const audit = await auditOf(colleague.id);
      expect(audit).toEqual([
        {
          action: 'admin.password.reset_issued',
          admin_user_id: boss.id,
          reason: 'Forgot it after leave.',
          before: null,
          after: null,
        },
        {
          action: 'admin.password.reset_completed',
          admin_user_id: colleague.id,
          reason: null,
          before: null,
          after: null,
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain(token);
    });

    it('keeps the authenticator: the setup start offers no new secret', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const before = await pool.query<{ totp_secret_encrypted: string }>(
        `select totp_secret_encrypted from admin_users where id = $1`,
        [colleague.id],
      );
      const res = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({ reason: 'Reset' });
      const token = new URL((res.body as AdminInvitationIssued).setupLink).hash.slice(1);
      const started = await request(app.getHttpServer())
        .post('/admin/auth/setup/start')
        .send({ token });
      expect(JSON.stringify(started.body)).not.toContain('totpSecret');
      const after = await pool.query<{ totp_secret_encrypted: string }>(
        `select totp_secret_encrypted from admin_users where id = $1`,
        [colleague.id],
      );
      expect(after.rows).toEqual(before.rows);
    });

    it('refuses an expired link', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const res = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({ reason: 'Reset' });
      const token = new URL((res.body as AdminInvitationIssued).setupLink).hash.slice(1);
      await pool.query(
        `update admin_invitations set expires_at = now() - interval '1 minute' where admin_user_id = $1`,
        [colleague.id],
      );
      const completed = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: codeFor(colleague) });
      expect(completed.status).toBe(400);
      expect((completed.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    });

    it('needs admins.manage', async () => {
      const support = await enrolledAdmin(['support', 'moderator', 'finance']);
      const supportSession = await bearer(support.id);
      const colleague = await enrolledAdmin();
      const res = await as(supportSession.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({ reason: 'Reset' });
      expect(res.status).toBe(403);
      expect((await signInOver(colleague.email, PASSWORD, codeFor(colleague))).status).toBe(200);
    });

    it('refuses a super_admin resetting their own password this way', async () => {
      const boss = await superAdmin();
      const res = await as(boss.token)
        .post(`/admin/admins/${boss.id}/reset-password`)
        .send({ reason: 'Myself' });
      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_SELF_ACTION_REFUSED');
    });

    it('refuses an admin who never finished setup, who has no authenticator to prove', async () => {
      const boss = await superAdmin();
      const invited = await admins.createAdmin({
        email: `invited-${randomUUID()}@tezusta.az`,
        displayName: 'Rəna',
        roles: ['support'],
      });
      const res = await as(boss.token)
        .post(`/admin/admins/${invited.id}/reset-password`)
        .send({ reason: 'Reset' });
      expect(res.status).toBe(409);
    });

    async function issueReset(boss: { token: string }, colleagueId: string): Promise<string> {
      const res = await as(boss.token)
        .post(`/admin/admins/${colleagueId}/reset-password`)
        .send({ reason: 'Reset' });
      expect(res.status).toBe(200);
      return new URL((res.body as AdminInvitationIssued).setupLink).hash.slice(1);
    }

    it('ignores an enrolment sent on a reset link: the authenticator does not change', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const before = await pool.query(
        `select totp_secret_encrypted from admin_users where id = $1`,
        [colleague.id],
      );
      const token = await issueReset(boss, colleague.id);
      const completed = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: codeFor(colleague), enrolment: 'forged' });
      expect(completed.status).toBe(204);
      const after = await pool.query(
        `select totp_secret_encrypted from admin_users where id = $1`,
        [colleague.id],
      );
      expect(after.rows).toEqual(before.rows);
    });

    it('refuses a setup link completed without the enrolment it was offered', async () => {
      const invited = await admins.createAdmin({
        email: `invited-${randomUUID()}@tezusta.az`,
        displayName: 'Rəna',
        roles: ['support'],
      });
      const issued = await setup.issueInvitation(invited.id, null);
      const token = new URL(issued.link).hash.slice(1);
      const res = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: '123456' });
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    });

    it('lets a second-factor reset replace a pending password-reset link', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const token = await issueReset(boss, colleague.id);
      const second = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-second-factor`)
        .send({ reason: 'Lost phone too' });
      expect(second.status).toBe(200);
      const res = await request(app.getHttpServer())
        .post('/admin/auth/setup/start')
        .send({ token });
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).error.code).toBe('ADMIN_SETUP_LINK_INVALID');
    });

    it('refuses a disabled admin, and a reset without a reason', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const noReason = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({});
      expect(noReason.status).toBe(422);
      await pool.query(`update admin_users set status = 'disabled' where id = $1`, [colleague.id]);
      const disabled = await as(boss.token)
        .post(`/admin/admins/${colleague.id}/reset-password`)
        .send({ reason: 'Reset' });
      expect(disabled.status).toBe(409);
    });

    it('counts code guesses on a reset link toward the account lockout', async () => {
      const boss = await superAdmin();
      const colleague = await enrolledAdmin();
      const token = await issueReset(boss, colleague.id);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await request(app.getHttpServer())
          .post('/admin/auth/setup/complete')
          .send({ token, password: NEW_PASSWORD, code: '000000' });
        expect(res.status).toBe(400);
      }
      const locked = await request(app.getHttpServer())
        .post('/admin/auth/setup/complete')
        .send({ token, password: NEW_PASSWORD, code: codeFor(colleague) });
      expect(locked.status).toBe(429);
    });
  });

  describe('a change racing a reset', () => {
    it('writes nothing when the verified hash is no longer the stored one', async () => {
      const admin = await enrolledAdmin();
      const here = await bearer(admin.id);
      const changed = await admins.transaction((tx) =>
        admins.changePassword(
          {
            adminUserId: admin.id,
            // A reset cleared the hash after the current password was verified.
            expectedPasswordHash: 'scrypt$not-the-stored-hash',
            passwordHash: 'scrypt$the-new-hash',
            keepSessionId: here.sessionId,
          },
          new Date(),
          tx,
        ),
      );
      expect(changed).toBe(false);
      expect((await signInOver(admin.email, PASSWORD, codeFor(admin))).status).toBe(200);
    });
  });
});
