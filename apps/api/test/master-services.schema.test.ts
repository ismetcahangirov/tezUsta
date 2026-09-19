import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The database-level half of issue #37.
 *
 * `master-profile.e2e.test.ts` proves the endpoints behave; this file proves
 * the table would still hold together if something other than those endpoints
 * ever wrote to it — a seed script, a migration, a future admin tool. Zod runs
 * on the request path only, so every rule that must be true of the *data*
 * rather than of a request is a constraint, and a constraint nobody tested is
 * a constraint nobody knows fires.
 */

async function insertUser(pool: Pool, phone: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (id, phone_e164, status) VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
    [phone],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('Failed to insert the test user.');
  }
  return id;
}

async function insertMaster(pool: Pool, userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO masters (id, user_id, display_name) VALUES (gen_random_uuid(), $1, 'Rəşad') RETURNING id`,
    [userId],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('Failed to insert the test master.');
  }
  return id;
}

describe('the masters schema constraints (issue #37)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let phoneCounter = 0;

  function nextPhone(): string {
    phoneCounter += 1;
    return `+99455${String(phoneCounter).padStart(7, '0')}`;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('starts a new master unverified, unavailable and unrated', async () => {
    const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

    const { rows } = await pool.query<{
      verification_status: string;
      is_available: boolean;
      rating_sum: number;
      rating_count: number;
      suspended_at: Date | null;
    }>(
      `SELECT verification_status, is_available, rating_sum, rating_count, suspended_at
         FROM masters WHERE id = $1`,
      [masterId],
    );

    expect(rows[0]).toMatchObject({
      verification_status: 'pending_verification',
      is_available: false,
      rating_sum: 0,
      rating_count: 0,
      suspended_at: null,
    });
  });

  it('refuses a second master profile for the same account', async () => {
    const userId = await insertUser(pool, nextPhone());
    await insertMaster(pool, userId);

    await expect(insertMaster(pool, userId)).rejects.toThrow(/masters_user_id_unique/);
  });

  /**
   * The unique index deliberately covers soft-deleted rows too. A user id is
   * never reassigned, so a second profile is always a bug rather than a reuse
   * after deletion — and the correct behaviour, reviving the existing row, is
   * only forced if the insert cannot succeed.
   */
  it('still refuses a second profile after the first was soft-deleted', async () => {
    const userId = await insertUser(pool, nextPhone());
    const masterId = await insertMaster(pool, userId);
    await pool.query(`UPDATE masters SET deleted_at = now() WHERE id = $1`, [masterId]);

    await expect(insertMaster(pool, userId)).rejects.toThrow(/masters_user_id_unique/);
  });

  describe('suspension and its timestamp', () => {
    it('refuses a suspension with no date', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

      await expect(
        pool.query(`UPDATE masters SET verification_status = 'suspended' WHERE id = $1`, [
          masterId,
        ]),
      ).rejects.toThrow(/masters_suspension_consistent/);
    });

    /**
     * The direction that actually bites. A reinstatement that forgets to clear
     * `suspended_at` leaves behind the exact value a later query would read as
     * "still suspended", and the master would be silently undispatchable with
     * an `active` status saying otherwise.
     */
    it('refuses a reinstatement that leaves the suspension date behind', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));
      await pool.query(
        `UPDATE masters SET verification_status = 'suspended', suspended_at = now() WHERE id = $1`,
        [masterId],
      );

      await expect(
        pool.query(`UPDATE masters SET verification_status = 'active' WHERE id = $1`, [masterId]),
      ).rejects.toThrow(/masters_suspension_consistent/);
    });

    it('accepts a suspension and a reinstatement done together', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

      await pool.query(
        `UPDATE masters SET verification_status = 'suspended', suspended_at = now() WHERE id = $1`,
        [masterId],
      );
      await pool.query(
        `UPDATE masters SET verification_status = 'active', suspended_at = NULL WHERE id = $1`,
        [masterId],
      );

      const { rows } = await pool.query<{ verification_status: string; suspended_at: Date | null }>(
        `SELECT verification_status, suspended_at FROM masters WHERE id = $1`,
        [masterId],
      );
      expect(rows[0]).toMatchObject({ verification_status: 'active', suspended_at: null });
    });
  });

  it('refuses a rating aggregate that no set of reviews could produce', async () => {
    const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

    // Two reviews cannot total eleven stars on a five-star scale.
    await expect(
      pool.query(`UPDATE masters SET rating_sum = 11, rating_count = 2 WHERE id = $1`, [masterId]),
    ).rejects.toThrow(/masters_rating_aggregate/);

    await expect(
      pool.query(`UPDATE masters SET rating_count = -1 WHERE id = $1`, [masterId]),
    ).rejects.toThrow(/masters_rating_aggregate/);
  });

  it('refuses a display name that is only whitespace', async () => {
    const userId = await insertUser(pool, nextPhone());

    await expect(
      pool.query(
        `INSERT INTO masters (id, user_id, display_name) VALUES (gen_random_uuid(), $1, '   ')`,
        [userId],
      ),
    ).rejects.toThrow(/masters_display_name_length/);
  });

  /**
   * "No bio" already has a representation, and it is `null`. A blank string
   * would be a second one, and every reader would then have to know about
   * both.
   */
  it('refuses a bio that trims to nothing, but accepts no bio at all', async () => {
    const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

    await expect(
      pool.query(`UPDATE masters SET bio = '  ' WHERE id = $1`, [masterId]),
    ).rejects.toThrow(/masters_bio_length/);

    await pool.query(`UPDATE masters SET bio = NULL WHERE id = $1`, [masterId]);
  });

  /**
   * The cash-order brake issue #99 adds ahead of the accept predicate that
   * will read it (ADR-0009, ADR-0010 §Commission). Nothing in this repository
   * writes anything but the default yet — EPIC 12 builds that ledger — so
   * what these tests can prove today is that the column starts at zero for
   * every master and that the database, not convention, refuses a negative
   * debt.
   */
  describe('commission_debt_minor (issue #99)', () => {
    it('starts at zero for a newly created master', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

      const { rows } = await pool.query<{ commission_debt_minor: string }>(
        `SELECT commission_debt_minor FROM masters WHERE id = $1`,
        [masterId],
      );

      expect(rows[0]).toMatchObject({ commission_debt_minor: '0' });
    });

    it('refuses a negative commission debt', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

      await expect(
        pool.query(`UPDATE masters SET commission_debt_minor = -1 WHERE id = $1`, [masterId]),
      ).rejects.toThrow(/masters_commission_debt_non_negative/);
    });

    it('accepts a positive debt, since EPIC 12 is what will write one', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));

      await pool.query(`UPDATE masters SET commission_debt_minor = 1500 WHERE id = $1`, [masterId]);

      const { rows } = await pool.query<{ commission_debt_minor: string }>(
        `SELECT commission_debt_minor FROM masters WHERE id = $1`,
        [masterId],
      );
      expect(rows[0]).toMatchObject({ commission_debt_minor: '1500' });
    });
  });

  describe('master_services', () => {
    async function anyFixedService(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM services WHERE pricing_kind = 'fixed' ORDER BY display_order, id LIMIT 1`,
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error('The seeded catalogue has no fixed-price service.');
      }
      return id;
    }

    it('refuses the same service offered twice by one master', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));
      const serviceId = await anyFixedService();

      await pool.query(
        `INSERT INTO master_services (master_id, service_id, price_minor) VALUES ($1, $2, 2500)`,
        [masterId, serviceId],
      );

      await expect(
        pool.query(
          `INSERT INTO master_services (master_id, service_id, price_minor) VALUES ($1, $2, 3000)`,
          [masterId, serviceId],
        ),
      ).rejects.toThrow(/master_services_master_id_service_id_pk/);
    });

    it('refuses a free or negative price', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));
      const serviceId = await anyFixedService();

      for (const price of [0, -1]) {
        await expect(
          pool.query(
            `INSERT INTO master_services (master_id, service_id, price_minor) VALUES ($1, $2, $3)`,
            [masterId, serviceId, price],
          ),
        ).rejects.toThrow(/master_services_price_positive/);
      }
    });

    /**
     * `onDelete: 'restrict'` everywhere. A catalogue service that masters
     * offer is retired by deactivation; a hard delete reaching it is a mistake,
     * and the right answer to a mistake is a failed statement rather than the
     * silent disappearance of every master's price for it.
     */
    it('refuses to delete a catalogue service that masters still offer', async () => {
      const masterId = await insertMaster(pool, await insertUser(pool, nextPhone()));
      const serviceId = await anyFixedService();
      await pool.query(
        `INSERT INTO master_services (master_id, service_id, price_minor) VALUES ($1, $2, 4000)`,
        [masterId, serviceId],
      );

      await expect(pool.query(`DELETE FROM services WHERE id = $1`, [serviceId])).rejects.toThrow(
        /master_services_service_id_services_id_fk/,
      );
    });
  });
});

/**
 * The matching filter, proved against a table big enough for the planner to
 * have a choice.
 *
 * Issue #37 asks for the `(service_id, master_id)` index now rather than after
 * a performance incident, and issue #7 (EPIC 7) is what will run the query. On
 * a handful of rows a sequential scan is genuinely the cheapest plan, so an
 * EXPLAIN against a small table asserts nothing except that the planner can
 * count. `enable_seqscan = off` would have been worse still: it produces a
 * green test on a missing index, which is the exact failure this guards.
 */
describe('the nearby-master capability filter (issue #37, consumed by EPIC 7)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;

  const MASTER_COUNT = 4_000;
  const OFFERS_PER_MASTER = 3;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    await pool.query(
      `INSERT INTO users (id, phone_e164, status)
       SELECT gen_random_uuid(), '+9945' || lpad(n::text, 8, '0'), 'active'
         FROM generate_series(1, $1) AS n`,
      [MASTER_COUNT],
    );
    await pool.query(
      `INSERT INTO masters (id, user_id, display_name, verification_status)
       SELECT gen_random_uuid(), id, 'Usta', 'active' FROM users`,
    );

    // Spread the offers across every active service rather than piling them
    // onto one. A predicate that matches most of the table is a predicate the
    // planner is right to ignore, and the test would then be asserting the
    // planner's mistake rather than the index's existence.
    //
    // Two thirds active, so the partial index is meaningfully narrower than
    // the table and a plan that ignored `is_active` would show up.
    await pool.query(
      `WITH offered AS (
         SELECT id, row_number() OVER (ORDER BY id) - 1 AS ord, count(*) OVER () AS total
           FROM services WHERE is_active AND pricing_kind = 'fixed'
       ),
       ranked AS (
         SELECT id, row_number() OVER (ORDER BY id) - 1 AS ord FROM masters
       )
       INSERT INTO master_services (master_id, service_id, price_minor, is_active)
       SELECT ranked.id,
              offered.id,
              2000 + (ranked.ord % 50) * 100,
              (ranked.ord + k) % 3 <> 0
         FROM ranked
         CROSS JOIN generate_series(0, $1 - 1) AS k
         JOIN offered ON offered.ord = (ranked.ord * $1 + k) % offered.total`,
      [OFFERS_PER_MASTER],
    );
    await pool.query('ANALYZE masters, master_services');
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  /**
   * Asserting the index is *used*, not which scan node uses it.
   *
   * With a few hundred masters per service the planner picks a Bitmap Index
   * Scan over a plain Index Scan — measured, not assumed — because reading
   * several hundred scattered heap pages in physical order beats seeking them
   * one at a time. Both plans read the index; pinning the node name here would
   * encode one row count and fail the day Baku has more masters, when the
   * other plan wins and is *also* correct.
   *
   * What must hold either way is CLAUDE.md §12: the hot path does not scan the
   * table. That is what a missing index produces, and it is what this asserts.
   */
  it('finds the masters who offer a service without scanning the table', async () => {
    const { rows: service } = await pool.query<{ id: string }>(
      `SELECT service_id AS id FROM master_services GROUP BY service_id ORDER BY count(*) LIMIT 1`,
    );

    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT master_id FROM master_services WHERE is_active AND service_id = $1`,
      [service[0]?.id],
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Scan .*master_services_service_master_idx/);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  /**
   * The mirror read — "what does this master offer?" — is served by the
   * primary key, which is why `master_services` has no surrogate id and no
   * separate index on `master_id`. If this ever stops holding, the composite
   * key stopped being the right shape.
   */
  it("reads one master's own offers through the primary key", async () => {
    const { rows: master } = await pool.query<{ id: string }>(`SELECT id FROM masters LIMIT 1`);

    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT service_id, price_minor FROM master_services WHERE master_id = $1`,
      [master[0]?.id],
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Scan .*master_services_master_id_service_id_pk/);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});
