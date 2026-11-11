import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminAccountRecovery,
  AdminAccountRecoveryEmails,
  AdminAccountRecoveryPhoto,
  AdminAccountRecoveryPhotoDownload,
  AdminAccountRecoveryPhotoUpload,
  AdminRole,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { EmailSender, OutboundEmail } from '../src/infra/email/email-sender.types';
import { EMAIL_SENDER } from '../src/infra/email/email-sender.types';
import { StubEmailSender } from '../src/infra/email/stub-email-sender';
import type {
  RateLimitConfig,
  RateLimitPolicy,
  RateLimitPolicyName,
} from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import type { StubStorageProvider } from '../src/infra/storage/stub-storage.provider';
import { STORAGE_PROVIDER } from '../src/infra/storage/storage.types';
import { AccountRecoveryPhotosRepository } from '../src/modules/account-recovery/account-recovery-photos.repository';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Support-mediated account recovery (#515, ADR-0074 §§ 2–5), end to end: real
 * HTTP through `AppModule`, a real Postgres and the shared Redis.
 *
 * What it pins down: who may take each step; that the hold, the second admin
 * and the code from the new address are each required; that the move goes
 * through the same mover as the self-serve change and revokes every session;
 * that the cancel link stops a recovery and says nothing about tokens; and
 * that the races the issue names leave exactly one outcome.
 */

class CapturingEmailSender implements EmailSender {
  readonly sent: OutboundEmail[] = [];

  constructor(private readonly inner: EmailSender) {}

  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    await this.inner.send(message);
  }

  to(email: string): OutboundEmail[] {
    return this.sent.filter((sent) => sent.to === email);
  }

  lastTo(email: string): OutboundEmail {
    const message = this.to(email).at(-1);
    if (message === undefined) {
      throw new Error(`No email was sent to ${email}.`);
    }
    return message;
  }

  lastCodeFor(email: string): string {
    const match = /\d{4,12}/.exec(this.lastTo(email).text);
    if (match === null) {
      throw new Error('The email body carried no code.');
    }
    return match[0];
  }

  /** The token in the cancel link of the last notice to `email`. */
  lastCancelTokenFor(email: string): string {
    const match = /\/account-recovery\/cancel#([A-Za-z0-9_-]+)/.exec(this.lastTo(email).text);
    if (match?.[1] === undefined) {
      throw new Error('The notice carried no cancel link.');
    }
    return match[1];
  }
}

const UNREACHABLE = 1_000_000;
const POLICY_NAMES: readonly RateLimitPolicyName[] = [
  'otp-request',
  'sign-in',
  'refresh',
  'geocode',
  'document-upload',
  'order-creation',
  'order-transition',
  'order-search-read',
  'price-range',
  'location-report',
  'offer-response',
  'offer-feed',
  'device-registration',
  'message-send',
  'review-submit',
  'report-submit',
  'portfolio-upload',
  'portfolio-write',
  'subscription-checkout',
  'profile-read',
  'admin-setup',
  'admin-sign-in',
];

function policy(perIdentifier: number): RateLimitPolicy {
  return { perIdentifier, perIp: UNREACHABLE, windowMs: 10_000, backoffCeilingMs: 10_000 };
}

const testRateLimits: RateLimitConfig = {
  keySecret: `account-recovery-e2e-pepper-${randomUUID()}`,
  policies: Object.fromEntries(POLICY_NAMES.map((name) => [name, policy(UNREACHABLE)])) as Record<
    RateLimitPolicyName,
    RateLimitPolicy
  >,
};

/** ADR-0072's cap, which the recovery code inherits. */
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let pool: Pool;
let mail: CapturingEmailSender;
let counter = 0;

interface Admin {
  readonly id: string;
  readonly token: string;
}

interface Account {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly subject: { readonly kind: 'customer' | 'master'; readonly id: string };
}

function nextEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}@example.com`;
}

async function one<T>(text: string, params: unknown[]): Promise<T> {
  const { rows } = await pool.query<T & object>(text, params);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No row from: ${text}`);
  }
  return row;
}

async function adminWith(roles: readonly AdminRole[]): Promise<Admin> {
  const created = await app.get(AdminRepository).createAdmin({
    email: `admin-${randomUUID()}@tezusta.az`,
    displayName: 'Nigar',
    roles,
  });
  return {
    id: created.id,
    token: (await app.get(AdminSessionService).start(created.id)).accessToken,
  };
}

/** A signed-in customer, or a master (with a customer profile too, as masters have). */
async function account(kind: 'customer' | 'master'): Promise<Account> {
  const email = nextEmail(kind);
  const { user } = await app
    .get(UsersRepository)
    .create({ email, roles: kind === 'master' ? ['customer', 'master'] : ['customer'] });
  const customer = await one<{ id: string }>(
    `insert into customers (id, user_id, display_name) values (gen_random_uuid(), $1, 'Aysel') returning id`,
    [user.id],
  );
  let subjectId = customer.id;
  if (kind === 'master') {
    subjectId = (
      await one<{ id: string }>(
        `insert into masters (id, user_id, display_name) values (gen_random_uuid(), $1, 'Usta Elçin') returning id`,
        [user.id],
      )
    ).id;
  }
  const pair = await app.get(SessionsService).startSession({ userId: user.id });
  return {
    userId: user.id,
    email,
    accessToken: pair.accessToken,
    subject: { kind, id: subjectId },
  };
}

function as(admin: Admin, method: 'get' | 'post', path: string) {
  return request(app.getHttpServer())[method](path).set('authorization', `Bearer ${admin.token}`);
}

function open(admin: Admin, target: Account, newEmail: string) {
  return as(admin, 'post', '/admin/account-recoveries').send({
    subject: target.subject,
    newEmail,
    evidenceNotes: 'Selfie with the same ID card; card number matches the file.',
  });
}

function verify(admin: Admin, id: string, code: string) {
  return as(admin, 'post', `/admin/account-recoveries/${id}/verify`).send({ code });
}

function approve(admin: Admin, id: string) {
  return as(admin, 'post', `/admin/account-recoveries/${id}/approve`).send({
    reason: 'Evidence matched; hold passed without objection.',
  });
}

function cancelByLink(token: string) {
  return request(app.getHttpServer()).post('/account-recovery/cancel').send({ token });
}

function wrong(code: string): string {
  return code === '0'.repeat(code.length) ? '1'.repeat(code.length) : '0'.repeat(code.length);
}

/** Opened and verified: the hold is running. */
async function onHold(opener: Admin, target: Account, newEmail: string): Promise<string> {
  const opened = await open(opener, target, newEmail);
  expect(opened.status).toBe(201);
  const id = (opened.body as AdminAccountRecovery).id;
  const verified = await verify(opener, id, mail.lastCodeFor(newEmail));
  expect(verified.status).toBe(200);
  return id;
}

/** Moves the hold into the past, as 72 hours passing would. */
async function endHold(id: string): Promise<void> {
  await pool.query(
    `update account_recovery_requests set hold_until = now() - interval '1 minute' where id = $1`,
    [id],
  );
}

async function emailOf(userId: string): Promise<string> {
  return (await one<{ email: string }>(`select email from users where id = $1`, [userId])).email;
}

async function liveSessions(userId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `select count(*) as n from sessions where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return Number(row.n);
}

async function auditActions(id: string): Promise<{ action: string; admin_user_id: string }[]> {
  const { rows } = await pool.query<{ action: string; admin_user_id: string }>(
    `select action, admin_user_id from admin_audit_log
      where target_type = 'account_recovery' and target_id = $1 order by created_at, id`,
    [id],
  );
  return rows;
}

async function stateOf(id: string): Promise<AdminAccountRecovery['status']> {
  const row = await one<{
    moved_at: Date | null;
    cancelled_at: Date | null;
    hold_until: Date | null;
  }>(`select moved_at, cancelled_at, hold_until from account_recovery_requests where id = $1`, [
    id,
  ]);
  if (row.moved_at !== null) return 'moved';
  if (row.cancelled_at !== null) return 'cancelled';
  if (row.hold_until === null) return 'awaiting_code';
  return row.hold_until.getTime() <= Date.now() ? 'ready' : 'on_hold';
}

beforeAll(async () => {
  const baseUrl = parseEnv(process.env).database.url;
  database = await createThrowawayDatabase(baseUrl);
  await runMigrations(database.url);
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testRateLimits)
    .overrideProvider(EMAIL_SENDER)
    .useValue(new CapturingEmailSender(new StubEmailSender('test')))
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  pool = new Pool({ connectionString: database.url });
  pool.on('error', () => undefined);
  mail = app.get<CapturingEmailSender>(EMAIL_SENDER);
}, 60_000);

afterAll(async () => {
  // Shared Redis: clear exactly the attempt counters this suite made.
  const { rows } = await pool.query<{ id: string }>(`select id from account_recovery_requests`);
  const limiter = app.get(RateLimiterService);
  await Promise.all(rows.map((row) => limiter.clearAttempts('account-recovery-verify', row.id)));
  await pool.end();
  await app.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  await database.drop();
});

describe('a recovery from open to move (ADR-0074 § 2)', () => {
  it.each(['customer', 'master'] as const)(
    'moves a %s account on a second admin’s approval after the hold',
    async (kind) => {
      const support = await adminWith(['support']);
      const approver = await adminWith(['super_admin']);
      const target = await account(kind);
      const newEmail = nextEmail('recovered');

      const opened = await open(support, target, `  ${newEmail.toUpperCase()} `);
      expect(opened.status).toBe(201);
      const created = opened.body as AdminAccountRecovery;
      expect(created.status).toBe('awaiting_code');
      expect(created.oldEmailMasked).not.toContain(target.email.split('@')[0]);
      expect(JSON.stringify(created)).not.toContain(newEmail);
      // The code goes to the new address; nothing to the old one yet.
      expect(mail.to(newEmail)).toHaveLength(1);
      expect(mail.to(target.email)).toHaveLength(0);

      const code = mail.lastCodeFor(newEmail);
      const verified = await verify(support, created.id, code);
      expect(verified.status).toBe(200);
      const held = verified.body as AdminAccountRecovery;
      expect(held.status).toBe('on_hold');
      const holdMs =
        new Date(held.holdUntil ?? 0).getTime() - new Date(held.codeVerifiedAt ?? 0).getTime();
      expect(holdMs).toBe(72 * HOUR_MS);

      // The old address is told, with a cancel link and no code.
      const notice = mail.lastTo(target.email);
      expect(notice.text).toContain('/account-recovery/cancel#');
      expect(notice.text).not.toContain(newEmail);
      expect(notice.text).not.toContain(code);

      // Nothing is frozen during the hold.
      expect(await liveSessions(target.userId)).toBe(1);

      await endHold(created.id);
      const moved = await approve(approver, created.id);
      expect(moved.status).toBe(200);
      expect((moved.body as AdminAccountRecovery).status).toBe('moved');
      expect((moved.body as AdminAccountRecovery).approvedByAdminId).toBe(approver.id);
      // What the panel shows beside the request (#517).
      expect(moved.body as AdminAccountRecovery).toMatchObject({
        accountName: kind === 'master' ? 'Usta Elçin' : 'Aysel',
        openedByName: 'Nigar',
        approvedByName: 'Nigar',
        cancelledByName: null,
      });

      expect(await emailOf(target.userId)).toBe(newEmail);
      expect(await liveSessions(target.userId)).toBe(0);
      // The profiles, and everything keyed on them, stay with the account.
      const profile = await one<{ user_id: string }>(
        `select user_id from ${kind === 'master' ? 'masters' : 'customers'} where id = $1`,
        [target.subject.id],
      );
      expect(profile.user_id).toBe(target.userId);

      // Both addresses are told, and neither notice names the new address in full.
      expect(mail.lastTo(target.email).subject).toBe(mail.lastTo(newEmail).subject);
      expect(mail.lastTo(target.email).text).not.toContain(newEmail);

      expect(await auditActions(created.id)).toEqual([
        { action: 'account.recovery.open', admin_user_id: support.id },
        { action: 'account.recovery.verify', admin_user_id: support.id },
        { action: 'account.recovery.move', admin_user_id: approver.id },
      ]);
      const move = await one<{ reason: string; after: Record<string, string> }>(
        `select reason, after from admin_audit_log where target_id = $1 and action = 'account.recovery.move'`,
        [created.id],
      );
      expect(move.reason).toContain('Evidence matched');
      expect(move.after).toMatchObject({
        openedByAdminId: support.id,
        approvedByAdminId: approver.id,
      });
    },
  );
});

describe('what the move waits for', () => {
  it('is refused before the hold ends, saying when it does', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));

    const early = await approve(approver, id);
    expect(early.status).toBe(409);
    expect((early.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_HOLD_RUNNING');
    expect(await emailOf(target.userId)).toBe(target.email);
  });

  it('is refused before the code from the new address was entered', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const opened = await open(support, target, nextEmail('new'));
    const id = (opened.body as AdminAccountRecovery).id;

    const refused = await approve(approver, id);
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error).toMatchObject({
      code: 'ACCOUNT_RECOVERY_NOT_ALLOWED_NOW',
      details: { status: 'awaiting_code' },
    });
  });

  it('is refused for a cancelled request', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));
    const cancelled = await as(support, 'post', `/admin/account-recoveries/${id}/cancel`).send({
      reason: 'The user called: they found their password.',
    });
    expect(cancelled.status).toBe(200);
    expect(mail.lastTo(target.email).subject).toContain('ləğv');
    await endHold(id);

    const refused = await approve(approver, id);
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_NOT_ALLOWED_NOW');
    expect(await emailOf(target.userId)).toBe(target.email);
  });

  it('refuses a wrong code, and cancels the request once the attempts are spent', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    const newEmail = nextEmail('new');
    const opened = await open(support, target, newEmail);
    const id = (opened.body as AdminAccountRecovery).id;
    const code = mail.lastCodeFor(newEmail);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const refused = await verify(support, id, wrong(code));
      expect(refused.status).toBe(422);
      expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_CODE_INVALID');
    }
    expect(await stateOf(id)).toBe('cancelled');
    // The right code is no use now.
    expect((await verify(support, id, code)).status).toBe(409);
    // And the old address was never told about a hold that never started.
    expect(mail.to(target.email)).toHaveLength(0);
  });

  it('accepts a resent code and not the first one', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    const newEmail = nextEmail('new');
    const opened = await open(support, target, newEmail);
    const id = (opened.body as AdminAccountRecovery).id;
    const first = mail.lastCodeFor(newEmail);

    expect((await as(support, 'post', `/admin/account-recoveries/${id}/code`)).status).toBe(200);
    const second = mail.lastCodeFor(newEmail);
    if (first !== second) {
      expect((await verify(support, id, first)).status).toBe(422);
    }
    expect((await verify(support, id, second)).status).toBe(200);
  });
});

describe('what an open is refused for', () => {
  it('refuses a second open request for the account', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    expect((await open(support, target, nextEmail('new'))).status).toBe(201);

    const second = await open(support, target, nextEmail('new'));
    expect(second.status).toBe(409);
    expect((second.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_ALREADY_OPEN');
  });

  it('refuses an address another account signs in with', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    const other = await account('customer');

    const refused = await open(support, target, other.email);
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_ADDRESS_TAKEN');
  });

  it('refuses a suspended account', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    await pool.query(`update users set status = 'suspended' where id = $1`, [target.userId]);

    const refused = await open(support, target, nextEmail('new'));
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_ACCOUNT_INACTIVE');
  });

  it('refuses while the user has a self-serve change pending, and the change refuses while a recovery is open', async () => {
    const support = await adminWith(['support']);
    const changing = await account('customer');
    const started = await request(app.getHttpServer())
      .post('/me/email-change')
      .set('authorization', `Bearer ${changing.accessToken}`)
      .send({ newEmail: nextEmail('self') });
    expect(started.status).toBe(200);

    const refused = await open(support, changing, nextEmail('new'));
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_CHANGE_PENDING');

    const recovering = await account('customer');
    expect((await open(support, recovering, nextEmail('new'))).status).toBe(201);
    const blocked = await request(app.getHttpServer())
      .post('/me/email-change')
      .set('authorization', `Bearer ${recovering.accessToken}`)
      .send({ newEmail: nextEmail('self') });
    expect(blocked.status).toBe(409);
    expect((blocked.body as ErrorEnvelope).error.code).toBe('EMAIL_CHANGE_RECOVERY_PENDING');
  });

  it('answers 404 for a profile that does not exist', async () => {
    const support = await adminWith(['support']);
    const refused = await as(support, 'post', '/admin/account-recoveries').send({
      subject: { kind: 'master', id: randomUUID() },
      newEmail: nextEmail('new'),
      evidenceNotes: 'Notes.',
    });
    expect(refused.status).toBe(404);
  });
});

describe('who may do what (ADR-0074 § 3)', () => {
  it.each(['moderator', 'finance'] as const)('refuses %s at every step', async (role) => {
    const outsider = await adminWith([role]);
    const support = await adminWith(['support']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));

    expect((await as(outsider, 'get', '/admin/account-recoveries')).status).toBe(403);
    expect((await as(outsider, 'get', `/admin/account-recoveries/${id}`)).status).toBe(403);
    expect((await open(outsider, await account('customer'), nextEmail('new'))).status).toBe(403);
    expect((await verify(outsider, id, '123456')).status).toBe(403);
    expect(
      (await as(outsider, 'post', `/admin/account-recoveries/${id}/cancel`).send({ reason: 'x' }))
        .status,
    ).toBe(403);
    await endHold(id);
    expect((await approve(outsider, id)).status).toBe(403);
    expect(await stateOf(id)).toBe('ready');
  });

  it('refuses support on approve', async () => {
    const opener = await adminWith(['super_admin']);
    const support = await adminWith(['support']);
    const target = await account('customer');
    const id = await onHold(opener, target, nextEmail('new'));
    await endHold(id);

    const refused = await approve(support, id);
    expect(refused.status).toBe(403);
    expect(await stateOf(id)).toBe('ready');
  });

  it('refuses the super_admin who opened the request', async () => {
    const opener = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(opener, target, nextEmail('new'));
    await endHold(id);

    const refused = await approve(opener, id);
    expect(refused.status).toBe(403);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_SAME_ADMIN');
    expect(await emailOf(target.userId)).toBe(target.email);
  });

  it('lists open requests and reads one, audited, with both addresses masked', async () => {
    const support = await adminWith(['support']);
    const target = await account('master');
    const newEmail = nextEmail('new');
    const id = await onHold(support, target, newEmail);

    const list = await as(support, 'get', '/admin/account-recoveries');
    expect(list.status).toBe(200);
    expect((list.body as AdminAccountRecovery[]).map((row) => row.id)).toContain(id);
    expect(JSON.stringify(list.body)).not.toContain(newEmail);
    expect(JSON.stringify(list.body)).not.toContain(target.email);

    const detail = await as(support, 'get', `/admin/account-recoveries/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as AdminAccountRecovery).masterId).toBe(target.subject.id);
    expect((await auditActions(id)).map((row) => row.action)).toContain('account.recovery.read');
  });

  it('reveals both addresses only behind pii.read, with a reason, audited', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    const newEmail = nextEmail('new');
    const id = await onHold(support, target, newEmail);

    const revealed = await as(support, 'post', `/admin/account-recoveries/${id}/emails`).send({
      reason: 'Checking the address the user wrote from.',
    });
    expect(revealed.status).toBe(200);
    expect(revealed.body as AdminAccountRecoveryEmails).toEqual({
      oldEmail: target.email,
      newEmail,
    });
    const without = await as(support, 'post', `/admin/account-recoveries/${id}/emails`).send({});
    expect(without.status).toBe(422);
    expect((await auditActions(id)).map((row) => row.action)).toContain(
      'account.recovery.emails.read',
    );
  });
});

describe('the cancel link', () => {
  it('opens a page that asks, and cancels nothing by being opened', async () => {
    const support = await adminWith(['support']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));

    const page = await request(app.getHttpServer()).get('/account-recovery/cancel');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(await stateOf(id)).toBe('on_hold');
  });

  it('stops the recovery once, keeps the old address, and tells it', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));
    const token = mail.lastCancelTokenFor(target.email);

    const cancelled = await cancelByLink(token);
    expect(cancelled.status).toBe(204);
    expect(await stateOf(id)).toBe('cancelled');
    expect(mail.lastTo(target.email).subject).toContain('ləğv');
    const sentBefore = mail.sent.length;

    // Used: the same answer, and nothing more happens.
    expect((await cancelByLink(token)).status).toBe(204);
    expect(mail.sent.length).toBe(sentBefore);

    await endHold(id);
    expect((await approve(approver, id)).status).toBe(409);
    expect(await emailOf(target.userId)).toBe(target.email);
  });

  it('answers an unknown, malformed-looking or spent token exactly as a good one', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));
    const token = mail.lastCancelTokenFor(target.email);
    await endHold(id);
    expect((await approve(approver, id)).status).toBe(200);

    for (const candidate of [token, randomUUID(), 'x']) {
      const answer = await cancelByLink(candidate);
      expect(answer.status).toBe(204);
      expect(answer.text).toBe('');
    }
    // A spent token did not undo the move.
    expect(await stateOf(id)).toBe('moved');
  });
});

describe('races (#515)', () => {
  it('leaves one open request when two admins open at once', async () => {
    const first = await adminWith(['support']);
    const second = await adminWith(['support']);
    const target = await account('customer');

    const answers = await Promise.all([
      open(first, target, nextEmail('new')),
      open(second, target, nextEmail('new')),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    const { rows } = await pool.query(
      `select id from account_recovery_requests where user_id = $1 and cancelled_at is null and moved_at is null`,
      [target.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('lets exactly one of a cancel and an approval take effect', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const newEmail = nextEmail('new');
    const id = await onHold(support, target, newEmail);
    const token = mail.lastCancelTokenFor(target.email);
    await endHold(id);

    const [moved] = await Promise.all([approve(approver, id), cancelByLink(token)]);
    const state = await stateOf(id);
    if (moved.status === 200) {
      expect(state).toBe('moved');
      expect(await emailOf(target.userId)).toBe(newEmail);
    } else {
      expect(state).toBe('cancelled');
      expect(await emailOf(target.userId)).toBe(target.email);
    }
  });

  it('moves the account once when two admins approve at once', async () => {
    const support = await adminWith(['support']);
    const first = await adminWith(['super_admin']);
    const second = await adminWith(['super_admin']);
    const target = await account('customer');
    const id = await onHold(support, target, nextEmail('new'));
    await endHold(id);

    const answers = await Promise.all([approve(first, id), approve(second, id)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const moves = (await auditActions(id)).filter((row) => row.action === 'account.recovery.move');
    expect(moves).toHaveLength(1);
  });

  it('cancels the request when the new address was taken during the hold', async () => {
    const support = await adminWith(['support']);
    const approver = await adminWith(['super_admin']);
    const target = await account('customer');
    const newEmail = nextEmail('new');
    const id = await onHold(support, target, newEmail);
    await app.get(UsersRepository).create({ email: newEmail, roles: ['customer'] });
    await endHold(id);

    const refused = await approve(approver, id);
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_ADDRESS_TAKEN');
    expect(await stateOf(id)).toBe('cancelled');
    expect(await emailOf(target.userId)).toBe(target.email);
    expect(await liveSessions(target.userId)).toBe(1);
  });
});

describe('what stays out of the audit log', () => {
  it('keeps the evidence notes on the request, not in the audit row', async () => {
    const support = await adminWith(['support']);
    const target = await account('master');
    const opened = await as(support, 'post', '/admin/account-recoveries').send({
      subject: target.subject,
      newEmail: nextEmail('new'),
      evidenceNotes: 'ID card AZE 12345678 matches the file.',
    });
    expect(opened.status).toBe(201);
    const { rows } = await pool.query<{ row: string }>(
      `select row_to_json(a)::text as row from admin_audit_log a where target_id = $1`,
      [(opened.body as AdminAccountRecovery).id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      expect(row).not.toContain('12345678');
    }
  });
});

describe('the evidence photos (#524, ADR-0074 § 2)', () => {
  type Kind = 'selfie_with_id' | 'id_card_front';

  function jpeg(size = 64): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  }

  function storage(): StubStorageProvider {
    return app.get<StubStorageProvider>(STORAGE_PROVIDER);
  }

  async function keyOf(photoId: string): Promise<string> {
    return (
      await one<{ storage_key: string }>(
        `select storage_key from account_recovery_photos where id = $1`,
        [photoId],
      )
    ).storage_key;
  }

  function presign(admin: Admin, id: string, kind: Kind) {
    return as(admin, 'post', `/admin/account-recoveries/${id}/photos`).send({
      kind,
      contentType: 'image/jpeg',
    });
  }

  function confirm(admin: Admin, id: string, photoId: string) {
    return as(admin, 'post', `/admin/account-recoveries/${id}/photos/${photoId}/confirm`);
  }

  function download(admin: Admin, id: string, photoId: string) {
    return as(admin, 'get', `/admin/account-recoveries/${id}/photos/${photoId}/download`);
  }

  /** Presigns, puts the bytes as the browser would, and confirms. */
  async function upload(admin: Admin, id: string, kind: Kind, bytes: Uint8Array = jpeg()) {
    const presigned = await presign(admin, id, kind);
    expect(presigned.status).toBe(201);
    const body = presigned.body as AdminAccountRecoveryPhotoUpload;
    const key = await keyOf(body.photoId);
    storage().putObject(key, bytes);
    return {
      photoId: body.photoId,
      key,
      upload: body,
      confirmed: await confirm(admin, id, body.photoId),
    };
  }

  async function photoAudit(photoId: string): Promise<{ action: string; admin_user_id: string }[]> {
    const { rows } = await pool.query<{ action: string; admin_user_id: string }>(
      `select action, admin_user_id from admin_audit_log
        where target_type = 'account_recovery_photo' and target_id = $1 order by created_at, id`,
      [photoId],
    );
    return rows;
  }

  async function openFor(kind: 'customer' | 'master', opener: Admin): Promise<string> {
    const opened = await open(opener, await account(kind), nextEmail('photos'));
    expect(opened.status).toBe(201);
    return (opened.body as AdminAccountRecovery).id;
  }

  it('stores both photos, and a second admin reads them through audited links', async () => {
    const support = await adminWith(['support']);
    const reviewer = await adminWith(['super_admin']);
    const id = await openFor('master', support);

    const selfie = await upload(support, id, 'selfie_with_id');
    expect(selfie.confirmed.status).toBe(200);
    const front = await upload(support, id, 'id_card_front');
    expect(front.confirmed.status).toBe(200);
    // The key is the server's: never in a response.
    expect(JSON.stringify(selfie.upload)).not.toContain(selfie.key);
    expect(JSON.stringify(selfie.confirmed.body)).not.toContain(selfie.key);

    const listed = await as(reviewer, 'get', `/admin/account-recoveries/${id}/photos`);
    expect(listed.status).toBe(200);
    const photos = listed.body as AdminAccountRecoveryPhoto[];
    expect(photos.map((photo) => photo.kind).sort()).toEqual(['id_card_front', 'selfie_with_id']);
    expect(photos[0]?.uploadedByName).toBe('Nigar');
    expect(photos[0]?.uploadedByAdminId).toBe(support.id);

    const read = await download(reviewer, id, selfie.photoId);
    expect(read.status).toBe(200);
    expect((read.body as AdminAccountRecoveryPhotoDownload).url).toEqual(expect.any(String));

    expect(await photoAudit(selfie.photoId)).toEqual([
      { action: 'account.recovery.photo.add', admin_user_id: support.id },
      { action: 'account.recovery.photo.read', admin_user_id: reviewer.id },
    ]);
  });

  it('keeps one photo of each kind and does not replace it', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);
    expect((await upload(support, id, 'selfie_with_id')).confirmed.status).toBe(200);

    const again = await presign(support, id, 'selfie_with_id');
    expect(again.status).toBe(409);
    expect((again.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_PHOTO_EXISTS');
  });

  it('replaces a presign nobody confirmed, and deletes what was behind it', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);
    const first = (await presign(support, id, 'id_card_front'))
      .body as AdminAccountRecoveryPhotoUpload;
    const firstKey = await keyOf(first.photoId);
    storage().putObject(firstKey, jpeg());

    const second = await presign(support, id, 'id_card_front');
    expect(second.status).toBe(201);
    expect(storage().hasObject(firstKey)).toBe(false);
    expect((await confirm(support, id, first.photoId)).status).toBe(404);
  });

  it('refuses at confirm a file that is not an image, or is over the cap, and deletes it', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);

    const html = await upload(
      support,
      id,
      'selfie_with_id',
      new TextEncoder().encode('<html><body>not a photo</body></html>'),
    );
    expect(html.confirmed.status).toBe(422);
    expect(storage().hasObject(html.key)).toBe(false);

    const presigned = (await presign(support, id, 'id_card_front'))
      .body as AdminAccountRecoveryPhotoUpload;
    const key = await keyOf(presigned.photoId);
    storage().putObject(key, jpeg(presigned.maxBytes + 1));
    const big = await confirm(support, id, presigned.photoId);
    expect(big.status).toBe(422);
    expect((big.body as ErrorEnvelope).error.details).toMatchObject({
      maxBytes: presigned.maxBytes,
    });
    expect(storage().hasObject(key)).toBe(false);

    // Nothing was stored, and nothing was audited as added.
    const listed = await as(support, 'get', `/admin/account-recoveries/${id}/photos`);
    expect(listed.body).toEqual([]);
    expect(await photoAudit(presigned.photoId)).toEqual([]);
  });

  it('says the file has not arrived when confirm comes before the upload', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);
    const presigned = (await presign(support, id, 'selfie_with_id'))
      .body as AdminAccountRecoveryPhotoUpload;
    expect((await confirm(support, id, presigned.photoId)).status).toBe(409);
  });

  it('takes no photos on a customer request', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('customer', support);
    const refused = await presign(support, id, 'selfie_with_id');
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_PHOTOS_MASTER_ONLY');
  });

  it('takes no photos once the request is closed, and still shows the stored ones', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);
    const selfie = await upload(support, id, 'selfie_with_id');
    const cancelled = await as(support, 'post', `/admin/account-recoveries/${id}/cancel`).send({
      reason: 'The user called; they found the old mailbox.',
    });
    expect(cancelled.status).toBe(200);

    const refused = await presign(support, id, 'id_card_front');
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('ACCOUNT_RECOVERY_NOT_ALLOWED_NOW');
    expect((await download(support, id, selfie.photoId)).status).toBe(200);
  });

  it.each([['moderator'], ['finance']] as const)(
    'refuses %s on every photo route',
    async (role) => {
      const support = await adminWith(['support']);
      const other = await adminWith([role]);
      const id = await openFor('master', support);
      const selfie = await upload(support, id, 'selfie_with_id');

      expect((await presign(other, id, 'id_card_front')).status).toBe(403);
      expect((await as(other, 'get', `/admin/account-recoveries/${id}/photos`)).status).toBe(403);
      expect((await download(other, id, selfie.photoId)).status).toBe(403);
      expect((await confirm(other, id, selfie.photoId)).status).toBe(403);
    },
  );

  it('answers 404 for a photo id of another request', async () => {
    const support = await adminWith(['support']);
    const first = await openFor('master', support);
    const second = await openFor('master', support);
    const selfie = await upload(support, first, 'selfie_with_id');
    expect((await download(support, second, selfie.photoId)).status).toBe(404);
  });

  it('lets the sweep clear a presign nobody confirmed, and never a stored photo', async () => {
    const support = await adminWith(['support']);
    const id = await openFor('master', support);
    const stored = await upload(support, id, 'selfie_with_id');
    const pending = (await presign(support, id, 'id_card_front'))
      .body as AdminAccountRecoveryPhotoUpload;
    const pendingKey = await keyOf(pending.photoId);
    storage().putObject(pendingKey, jpeg());
    await pool.query(
      `update account_recovery_photos set presign_expires_at = now() - interval '2 hours'
        where recovery_id = $1`,
      [id],
    );

    const photos = app.get(AccountRecoveryPhotosRepository);
    const candidates = await photos.listAbandoned(new Date(Date.now() - HOUR_MS), 100);
    const ids = candidates.map((candidate) => candidate.id);
    expect(ids).toContain(pending.photoId);
    expect(ids).not.toContain(stored.photoId);
    expect(await photos.deleteAbandoned(pending.photoId, (key) => storage().delete(key))).toBe(
      true,
    );
    expect(storage().hasObject(pendingKey)).toBe(false);
    expect(storage().hasObject(stored.key)).toBe(true);
  });
});
