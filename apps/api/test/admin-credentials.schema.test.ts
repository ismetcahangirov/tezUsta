import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The database-level half of issue #238 (ADR-0043 § 1–4, § 6).
 *
 * Nothing writes these tables yet — sign-in, setup and the permission guard
 * are later issues built on them — so the rules are proved with raw SQL, the
 * way `reviews.schema.test.ts` proves its table before a service exists. A
 * provisioning script or a future tool that never passes through a service
 * must meet the same walls.
 */
describe('the admin credential and role schema (issue #238)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let counter = 0;

  function hash(): string {
    counter += 1;
    return counter.toString(16).padStart(64, '0');
  }

  async function insertAdmin(): Promise<string> {
    counter += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (id, email, display_name)
       VALUES (gen_random_uuid(), $1, 'Admin') RETURNING id`,
      [`admin-${String(counter)}@tezusta.az`],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('Failed to insert the test admin.');
    }
    return id;
  }

  async function insertSession(adminUserId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO admin_sessions (id, admin_user_id, expires_at)
       VALUES (gen_random_uuid(), $1, now() + interval '8 hours') RETURNING id`,
      [adminUserId],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('Failed to insert the test session.');
    }
    return id;
  }

  async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error: unknown) {
      return (error as { code?: string }).code;
    }
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('roles', () => {
    it('lets one admin hold several roles', async () => {
      const admin = await insertAdmin();
      await pool.query(
        `INSERT INTO admin_user_roles (admin_user_id, role)
         VALUES ($1, 'support'), ($1, 'finance')`,
        [admin],
      );
      const { rows } = await pool.query<{ role: string }>(
        `SELECT role FROM admin_user_roles WHERE admin_user_id = $1 ORDER BY role`,
        [admin],
      );
      expect(rows.map((row) => row.role)).toEqual(['support', 'finance']);
    });

    it('refuses the same role twice', async () => {
      const admin = await insertAdmin();
      await pool.query(
        `INSERT INTO admin_user_roles (admin_user_id, role) VALUES ($1, 'moderator')`,
        [admin],
      );
      expect(
        await sqlState(
          pool.query(
            `INSERT INTO admin_user_roles (admin_user_id, role) VALUES ($1, 'moderator')`,
            [admin],
          ),
        ),
      ).toBe('23505');
    });

    it('refuses a role outside the four', async () => {
      const admin = await insertAdmin();
      expect(
        await sqlState(
          pool.query(`INSERT INTO admin_user_roles (admin_user_id, role) VALUES ($1, 'admin')`, [
            admin,
          ]),
        ),
      ).toBe('22P02');
    });
  });

  describe('credentials on admin_users', () => {
    it('accepts an invited account with no credential at all', async () => {
      const admin = await insertAdmin();
      const { rows } = await pool.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM admin_users WHERE id = $1`,
        [admin],
      );
      expect(rows[0]?.password_hash).toBeNull();
    });

    it('accepts an enrolled secret written together with its enrolment stamp', async () => {
      const admin = await insertAdmin();
      const { rowCount } = await pool.query(
        `UPDATE admin_users
            SET password_hash = 'scrypt$x', totp_secret_encrypted = 'v1.x', totp_enrolled_at = now(),
                last_totp_step = 59000000
          WHERE id = $1`,
        [admin],
      );
      expect(rowCount).toBe(1);
    });

    it('refuses an enrolment stamp without a secret', async () => {
      const admin = await insertAdmin();
      expect(
        await sqlState(
          pool.query(`UPDATE admin_users SET totp_enrolled_at = now() WHERE id = $1`, [admin]),
        ),
      ).toBe('23514');
    });

    it('refuses a secret without an enrolment stamp', async () => {
      const admin = await insertAdmin();
      expect(
        await sqlState(
          pool.query(`UPDATE admin_users SET totp_secret_encrypted = 'v1.x' WHERE id = $1`, [
            admin,
          ]),
        ),
      ).toBe('23514');
    });

    it('refuses a replay-guard step on an account that never enrolled', async () => {
      const admin = await insertAdmin();
      expect(
        await sqlState(
          pool.query(`UPDATE admin_users SET last_totp_step = 1 WHERE id = $1`, [admin]),
        ),
      ).toBe('23514');
    });
  });

  describe('invitations', () => {
    async function insertInvitation(
      adminUserId: string,
      tokenHash: string,
      extra: { usedAt?: string; revokedAt?: string } = {},
    ): Promise<unknown> {
      return pool.query(
        `INSERT INTO admin_invitations (id, admin_user_id, token_hash, expires_at, used_at, revoked_at)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '24 hours', $3, $4)`,
        [adminUserId, tokenHash, extra.usedAt ?? null, extra.revokedAt ?? null],
      );
    }

    it('refuses a token hash that is already stored', async () => {
      const admin = await insertAdmin();
      const tokenHash = hash();
      await insertInvitation(admin, tokenHash);
      expect(await sqlState(insertInvitation(admin, tokenHash))).toBe('23505');
    });

    it('refuses anything that is not a SHA-256 hex digest — a raw token cannot be stored', async () => {
      const admin = await insertAdmin();
      expect(await sqlState(insertInvitation(admin, 'raw-setup-token'))).toBe('23514');
    });

    it('refuses an invitation that is both used and revoked', async () => {
      const admin = await insertAdmin();
      expect(
        await sqlState(
          insertInvitation(admin, hash(), {
            usedAt: '2026-09-24T10:00:00Z',
            revokedAt: '2026-09-24T10:00:00Z',
          }),
        ),
      ).toBe('23514');
    });
  });

  describe('refresh tokens', () => {
    it('refuses a refresh token hash that is already stored', async () => {
      const session = await insertSession(await insertAdmin());
      const tokenHash = hash();
      const insert = (): Promise<unknown> =>
        pool.query(
          `INSERT INTO admin_refresh_tokens (id, session_id, token_hash) VALUES (gen_random_uuid(), $1, $2)`,
          [session, tokenHash],
        );
      await insert();
      expect(await sqlState(insert())).toBe('23505');
    });

    it('refuses a refresh token for a session that does not exist', async () => {
      expect(
        await sqlState(
          pool.query(
            `INSERT INTO admin_refresh_tokens (id, session_id, token_hash) VALUES (gen_random_uuid(), gen_random_uuid(), $1)`,
            [hash()],
          ),
        ),
      ).toBe('23503');
    });
  });

  describe('audit log before/after', () => {
    it('stores before and after, and stays append-only', async () => {
      const admin = await insertAdmin();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO admin_audit_log (id, admin_user_id, action, target_type, target_id, reason, before, after)
         VALUES (gen_random_uuid(), $1, 'master.suspend', 'master', gen_random_uuid(), 'Şikayət',
                 '{"status":"active"}', '{"status":"suspended"}')
         RETURNING id`,
        [admin],
      );
      const id = rows[0]?.id;

      const stored = await pool.query<{ before: unknown; after: unknown }>(
        `SELECT before, after FROM admin_audit_log WHERE id = $1`,
        [id],
      );
      expect(stored.rows[0]).toEqual({
        before: { status: 'active' },
        after: { status: 'suspended' },
      });

      await expect(
        pool.query(`UPDATE admin_audit_log SET after = '{}' WHERE id = $1`, [id]),
      ).rejects.toThrow();
      await expect(pool.query(`DELETE FROM admin_audit_log WHERE id = $1`, [id])).rejects.toThrow();
    });
  });
});
