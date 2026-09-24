import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { AdminAuditEntry, AdminRole, CursorPage } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The audit log read surface and before/after recording (issue #243,
 * [ADR-0043](docs/decisions/ADR-0043-admin-panel-policy.md) § 6).
 */
describe('GET /admin/audit-log (issue #243)', () => {
  let database: ThrowawayDatabase;
  let app: NestFastifyApplication;
  let pool: Pool;
  let admins: AdminRepository;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let phoneCounter = 0;

  async function newAdmin(roles: readonly AdminRole[]) {
    const created = await admins.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: `Admin ${randomUUID().slice(0, 4)}`,
      roles,
    });
    const session = await app.get(AdminSessionService).start(created.id);
    return { id: created.id, token: session.accessToken, displayName: created.displayName };
  }

  function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('authorization', `Bearer ${token}`);
  }

  async function page(query: string, token: string): Promise<CursorPage<AdminAuditEntry>> {
    const res = await get(`/admin/audit-log${query}`, token);
    expect(res.status).toBe(200);
    return res.body as CursorPage<AdminAuditEntry>;
  }

  async function activeMaster(): Promise<string> {
    phoneCounter += 1;
    const user = await pool.query<{ id: string }>(
      `insert into users (id, phone_e164, status) values (gen_random_uuid(), $1, 'active') returning id`,
      [`+99455${String(phoneCounter).padStart(7, '0')}`],
    );
    const master = await pool.query<{ id: string }>(
      `insert into masters (id, user_id, display_name, verification_status)
       values (gen_random_uuid(), $1, 'Rəşad', 'active') returning id`,
      [user.rows[0]?.id],
    );
    const id = master.rows[0]?.id;
    if (id === undefined) {
      throw new Error('Failed to insert the test master.');
    }
    return id;
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
    expect((await get('/admin/audit-log', support.token)).status).toBe(403);
  });

  it('records a master suspension with its status before and after, and its actor', async () => {
    const auditor = await newAdmin(['super_admin']);
    const moderator = await newAdmin(['moderator']);
    const masterId = await activeMaster();

    const suspended = await request(app.getHttpServer())
      .post(`/admin/masters/${masterId}/suspend`)
      .set('authorization', `Bearer ${moderator.token}`)
      .send({ reason: 'Müştəri şikayətləri.' });
    expect(suspended.status).toBe(201);

    const { items } = await page(`?targetType=master&targetId=${masterId}`, auditor.token);
    const entry = items.find((item) => item.action === 'master.suspend');
    expect(entry).toMatchObject({
      reason: 'Müştəri şikayətləri.',
      before: { verificationStatus: 'active' },
      after: { verificationStatus: 'suspended' },
      actor: { id: moderator.id, displayName: moderator.displayName },
    });
  });

  it('pages through rows that share one timestamp without losing or repeating any', async () => {
    const auditor = await newAdmin(['super_admin']);
    const actor = await newAdmin(['support']);
    const at = new Date('2026-01-01T00:00:00Z');
    await admins.transaction(async (tx) => {
      for (let index = 0; index < 5; index += 1) {
        await admins.appendAudit(
          {
            adminUserId: actor.id,
            action: 'test.same_instant',
            targetType: 'order',
            targetId: randomUUID(),
          },
          at,
          tx,
        );
      }
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?actorId=${actor.id}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const result = await page(query, auditor.token);
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('filters by action on whole segments and by time range', async () => {
    const auditor = await newAdmin(['super_admin']);
    const actor = await newAdmin(['support']);
    const targetId = randomUUID();
    for (const [action, at] of [
      ['master.verify', '2026-02-01T10:00:00Z'],
      ['master.document.read', '2026-02-02T10:00:00Z'],
      ['masters_export.run', '2026-02-03T10:00:00Z'],
    ] as const) {
      await admins.appendAudit(
        { adminUserId: actor.id, action, targetType: 'master', targetId },
        new Date(at),
      );
    }

    const byPrefix = await page(`?actorId=${actor.id}&action=master`, auditor.token);
    expect(byPrefix.items.map((item) => item.action).sort()).toEqual([
      'master.document.read',
      'master.verify',
    ]);

    const byRange = await page(
      `?actorId=${actor.id}&from=2026-02-01T12:00:00Z&to=2026-02-03T00:00:00Z`,
      auditor.token,
    );
    expect(byRange.items.map((item) => item.action)).toEqual(['master.document.read']);
  });

  it('refuses a target id without its type', async () => {
    const auditor = await newAdmin(['super_admin']);
    const res = await get(`/admin/audit-log?targetId=${randomUUID()}`, auditor.token);
    expect(res.status).toBe(422);
  });
});
