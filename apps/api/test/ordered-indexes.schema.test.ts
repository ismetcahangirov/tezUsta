import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Issue #191 — an ordered index that cannot serve the order it was built for.
 *
 * Drizzle's `.desc()` emits `DESC NULLS LAST` in an index definition, while a
 * bare `ORDER BY x DESC` means `DESC NULLS FIRST`. The planner compares the
 * ordering *specifications*, not what the data can contain, so a `NOT NULL`
 * column does not rescue the mismatch: Postgres uses the index for the filter
 * and then sorts every matching row anyway. Measured here on a scratch table,
 * 5 000 rows, Postgres 17:
 *
 * ```
 * (owner_id, created_at desc nulls last, id desc nulls last)  →  Index Only Scan + Sort
 * (owner_id, created_at desc,            id desc)             →  Index Only Scan, no sort
 * ```
 *
 * Two things are asserted below, and they answer different questions.
 *
 * **The guard** asks whether the defect exists anywhere in the schema at all.
 * It reads `pg_indexes` after the migrations have run, so it catches the next
 * `.desc()` somebody writes — including on a table that has no query yet, which
 * is precisely when the mistake is cheapest to make and most invisible.
 *
 * **The plan assertions** ask whether each index with a live consumer actually
 * removes the sort. A name in `pg_indexes` is not evidence that the planner
 * will use it for ordering; only `EXPLAIN` is. `enable_seqscan` and
 * `enable_bitmapscan` are turned off for those, because Postgres will choose a
 * sequential scan on a handful of rows whatever the indexes say — disabling the
 * alternatives turns the question into "can this index serve this order"
 * instead of "is it cheaper today" (`order-conversation.e2e.test.ts` does the
 * same for the same reason).
 */

interface PlanProbe {
  /** The `EXPLAIN`-able statement, with `$n` placeholders. */
  readonly sql: string;
  readonly parameters: readonly unknown[];
  /** The index that must appear in the plan. */
  readonly index: string;
}

describe('ordered indexes can serve the order they were built for (issue #191)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let phoneCounter = 0;

  function required<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(`Failed to insert the test ${what}.`);
    }
    return value;
  }

  function nextPhone(): string {
    phoneCounter += 1;
    return `+99451${String(phoneCounter).padStart(7, '0')}`;
  }

  async function insertUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (id, phone_e164, status)
       VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
      [nextPhone()],
    );
    return required(rows[0]?.id, 'user');
  }

  async function insertCustomer(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (id, user_id, display_name)
       VALUES (gen_random_uuid(), $1, 'Aygün') RETURNING id`,
      [await insertUser()],
    );
    return required(rows[0]?.id, 'customer');
  }

  async function insertAddress(customerId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO addresses (id, customer_id, formatted_address, position, is_default)
       VALUES (gen_random_uuid(), $1, 'Bakı, Nizami küçəsi 1',
               ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326), false)
       RETURNING id`,
      [customerId],
    );
    return required(rows[0]?.id, 'address');
  }

  async function insertMaster(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO masters (id, user_id, display_name)
       VALUES (gen_random_uuid(), $1, 'Rəşad') RETURNING id`,
      [await insertUser()],
    );
    return required(rows[0]?.id, 'master');
  }

  async function insertAdminUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (id, email, display_name)
       VALUES (gen_random_uuid(), $1, 'Admin') RETURNING id`,
      [`admin-${String((phoneCounter += 1))}-${Date.now().toString(36)}@tezusta.az`],
    );
    return required(rows[0]?.id, 'admin user');
  }

  /**
   * Enough rows that "no sort" is a statement about the ordering and not about
   * an empty table: a plan over zero rows can satisfy any order trivially.
   */
  const ROWS_PER_PROBE = 5;

  async function explain(probe: PlanProbe): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('set enable_seqscan = off');
      await client.query('set enable_bitmapscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `explain ${probe.sql}`,
        probe.parameters as unknown[],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await client.query('reset enable_seqscan');
      await client.query('reset enable_bitmapscan');
      client.release();
    }
  }

  async function expectServedWithoutSorting(probe: PlanProbe): Promise<void> {
    const plan = await explain(probe);
    expect(plan, `plan for ${probe.index}:\n${plan}`).toContain(probe.index);
    // `Incremental Sort` contains `Sort`, and is caught by the same assertion —
    // deliberately. It is what Postgres falls back to when the index carries
    // the leading ordering column but not the tiebreaker, and it is still a
    // sort node whose cost grows with the number of ties.
    expect(plan, `plan for ${probe.index}:\n${plan}`).not.toContain('Sort');
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM services WHERE is_active ORDER BY id LIMIT 1`,
    );
    serviceId = required(rows[0]?.id, 'service (the seed should provide one)');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  describe('the defect class itself', () => {
    it('leaves no index in the schema declared DESC NULLS LAST', async () => {
      const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexdef LIKE '%DESC NULLS LAST%'
          ORDER BY indexname`,
      );

      // Written as the offending definitions rather than a count, so a failure
      // names what to fix instead of only saying that something is wrong.
      expect(rows.map((row) => `${row.indexname}: ${row.indexdef}`)).toEqual([]);
    });
  });

  describe('the indexes with a live consumer', () => {
    it("serves the customer's order list — orders.repository.listByCustomer", async () => {
      const customerId = await insertCustomer();
      const addressId = await insertAddress(customerId);
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        await pool.query(
          `INSERT INTO orders (id, customer_id, address_id, service_id, status,
                               description, idempotency_key)
           VALUES (gen_random_uuid(), $1, $2, $3, 'SEARCHING', 'Kran sızır.', $4)`,
          [customerId, addressId, serviceId, `key-${String(index)}-${customerId}`],
        );
      }

      await expectServedWithoutSorting({
        index: 'orders_customer_created_idx',
        sql: `select id from orders
               where customer_id = $1 and status <> 'DRAFT'
               order by created_at desc, id desc
               limit 30`,
        parameters: [customerId],
      });
    });

    it("serves the customer's address list — addresses.repository.listByCustomer", async () => {
      const customerId = await insertCustomer();
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        await insertAddress(customerId);
      }

      await expectServedWithoutSorting({
        index: 'addresses_customer_live_idx',
        sql: `select id from addresses
               where customer_id = $1 and deleted_at is null
               order by is_default desc, created_at desc`,
        parameters: [customerId],
      });
    });

    it("serves a master's latest position — the LATERAL on the dispatch path", async () => {
      const masterId = await insertMaster();
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        await pool.query(
          `INSERT INTO master_locations (id, master_id, position, recorded_at)
           VALUES (gen_random_uuid(), $1,
                   ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326),
                   now() - ($2 || ' seconds')::interval)`,
          [masterId, String(index)],
        );
      }

      // `nearby-masters.repository.ts` runs exactly this once per candidate
      // master, so a sort here is a sort multiplied by the broadcast set.
      await expectServedWithoutSorting({
        index: 'master_locations_master_recent_idx',
        sql: `select position from master_locations
               where master_id = $1
               order by recorded_at desc, id desc
               limit 1`,
        parameters: [masterId],
      });
    });

    it("serves a master's verification trail — masterVerification.listHistory", async () => {
      const masterId = await insertMaster();
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        await pool.query(
          `INSERT INTO master_verification_history
             (id, master_id, from_status, to_status, actor_kind)
           VALUES (gen_random_uuid(), $1, 'pending_verification', 'active', 'system')`,
          [masterId],
        );
      }

      await expectServedWithoutSorting({
        index: 'master_verification_history_master_idx',
        sql: `select id from master_verification_history
               where master_id = $1
               order by created_at desc, id desc
               limit 30`,
        parameters: [masterId],
      });
    });

    it('serves the audit trail for one target — admin.listAuditForTarget', async () => {
      const adminUserId = await insertAdminUser();
      const targetId = await insertMaster();
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        await pool.query(
          `INSERT INTO admin_audit_log (id, admin_user_id, action, target_type, target_id)
           VALUES (gen_random_uuid(), $1, 'master.verify', 'master', $2)`,
          [adminUserId, targetId],
        );
      }

      await expectServedWithoutSorting({
        index: 'admin_audit_log_target_idx',
        sql: `select id from admin_audit_log
               where target_type = 'master' and target_id = $1
               order by created_at desc, id desc
               limit 30`,
        parameters: [targetId],
      });
    });

    it("serves a master's live offer feed — masterOffers.listLive", async () => {
      const customerId = await insertCustomer();
      const addressId = await insertAddress(customerId);
      const masterId = await insertMaster();
      for (let index = 0; index < ROWS_PER_PROBE; index += 1) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO orders (id, customer_id, address_id, service_id, status,
                               description, idempotency_key)
           VALUES (gen_random_uuid(), $1, $2, $3, 'SEARCHING', 'Kran sızır.', $4)
           RETURNING id`,
          [customerId, addressId, serviceId, `offer-key-${String(index)}-${masterId}`],
        );
        await pool.query(
          `INSERT INTO order_offers (id, order_id, master_id, round, radius_m, distance_m,
                                      status, expires_at)
           VALUES (gen_random_uuid(), $1, $2, 1, 3000, 900, 'offered',
                   now() + interval '5 minutes')`,
          [required(rows[0]?.id, 'order'), masterId],
        );
      }

      await expectServedWithoutSorting({
        index: 'order_offers_master_status_created_idx',
        sql: `select id from order_offers
               where master_id = $1 and status = 'offered'
               order by created_at desc`,
        parameters: [masterId],
      });
    });
  });
});
