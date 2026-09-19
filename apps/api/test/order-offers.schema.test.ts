import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The database-level half of issue #99.
 *
 * Nothing yet writes to `order_offers` — the dispatch engine and the accept
 * path are separate issues, built on this table rather than inventing it —
 * so everything here is exercised through raw SQL, the same way
 * `orders.schema.test.ts` proves `orders` and `order_status_history` hold
 * together before any service exists to write through them. The rules that
 * matter most (one offer row per master per order, forever; a response time
 * that says exactly what the status says) have to hold against whatever
 * writes here first, and a constraint nobody tested is a constraint nobody
 * knows fires.
 */

interface Fixture {
  readonly customerId: string;
  readonly addressId: string;
  readonly masterId: string;
  readonly serviceId: string;
}

describe('the order_offers schema constraints (issue #99)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let phoneCounter = 0;

  function nextPhone(): string {
    phoneCounter += 1;
    return `+99451${String(phoneCounter).padStart(7, '0')}`;
  }

  function required(value: string | undefined, what: string): string {
    if (value === undefined) {
      throw new Error(`Failed to insert the test ${what}.`);
    }
    return value;
  }

  async function insertUser(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (id, phone_e164, status)
       VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
      [nextPhone()],
    );
    return required(rows[0]?.id, 'user');
  }

  async function insertCustomer(userId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (id, user_id, display_name)
       VALUES (gen_random_uuid(), $1, 'Aygün') RETURNING id`,
      [userId],
    );
    return required(rows[0]?.id, 'customer');
  }

  async function insertAddress(customerId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO addresses (id, customer_id, formatted_address, position)
       VALUES (gen_random_uuid(), $1, 'Bakı, Nizami küçəsi 1',
               ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326))
       RETURNING id`,
      [customerId],
    );
    return required(rows[0]?.id, 'address');
  }

  async function insertMaster(): Promise<string> {
    const userId = await insertUser();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO masters (id, user_id, display_name) VALUES (gen_random_uuid(), $1, 'Rəşad') RETURNING id`,
      [userId],
    );
    return required(rows[0]?.id, 'master');
  }

  async function makeFixture(): Promise<Fixture> {
    const customerId = await insertCustomer(await insertUser());
    return {
      customerId,
      addressId: await insertAddress(customerId),
      masterId: await insertMaster(),
      serviceId,
    };
  }

  async function insertOrder(fixture: Fixture, status = 'SEARCHING'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (id, customer_id, address_id, service_id, status, description, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::order_status, 'Mətbəxdə kran sızır.', $5)
       RETURNING id`,
      [
        fixture.customerId,
        fixture.addressId,
        fixture.serviceId,
        status,
        `key-${crypto.randomUUID()}`,
      ],
    );
    return required(rows[0]?.id, 'order');
  }

  async function insertOffer(
    orderId: string,
    masterId: string,
    overrides: {
      round?: number;
      radiusM?: number;
      distanceM?: number;
      status?: string;
      expiresAt?: string;
      respondedAt?: string | null;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO order_offers (id, order_id, master_id, round, radius_m, distance_m, status,
                                  expires_at, responded_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::order_offer_status, $7, $8)
       RETURNING id`,
      [
        orderId,
        masterId,
        overrides.round ?? 1,
        overrides.radiusM ?? 3000,
        overrides.distanceM ?? 1200,
        overrides.status ?? 'offered',
        overrides.expiresAt ?? new Date(Date.now() + 30_000).toISOString(),
        overrides.respondedAt === undefined ? null : overrides.respondedAt,
      ],
    );
    return required(rows[0]?.id, 'order offer');
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

  it('records a fresh offer with no response yet', async () => {
    const fixture = await makeFixture();
    const orderId = await insertOrder(fixture);
    const offerId = await insertOffer(orderId, fixture.masterId);

    const { rows } = await pool.query<{
      status: string;
      responded_at: Date | null;
      round: number;
    }>(`SELECT status, responded_at, round FROM order_offers WHERE id = $1`, [offerId]);

    expect(rows[0]).toMatchObject({ status: 'offered', responded_at: null, round: 1 });
  });

  it('refuses a status outside the five ADR-0009 defines', async () => {
    const fixture = await makeFixture();
    const orderId = await insertOrder(fixture);
    await expect(insertOffer(orderId, fixture.masterId, { status: 'pending' })).rejects.toThrow(
      /invalid input value for enum/i,
    );
  });

  describe('declining is forever (ADR-0009)', () => {
    it('refuses a second offer row for the same order and master', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await insertOffer(orderId, fixture.masterId);

      await expect(insertOffer(orderId, fixture.masterId)).rejects.toThrow(
        /order_offers_order_master_unique/,
      );
    });

    it('lets a widening round re-offer by updating the existing row rather than inserting one', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      const offerId = await insertOffer(orderId, fixture.masterId, {
        round: 1,
        radiusM: 3000,
        status: 'expired',
      });

      await pool.query(
        `UPDATE order_offers SET round = 2, radius_m = 6000, status = 'offered', expires_at = now() + interval '30 seconds'
           WHERE id = $1`,
        [offerId],
      );

      const { rows } = await pool.query<{ round: number; status: string }>(
        `SELECT round, status FROM order_offers WHERE id = $1`,
        [offerId],
      );
      expect(rows[0]).toMatchObject({ round: 2, status: 'offered' });
    });

    it('lets the same order reach two different masters', async () => {
      const fixture = await makeFixture();
      const otherMasterId = await insertMaster();
      const orderId = await insertOrder(fixture);

      await insertOffer(orderId, fixture.masterId);
      await expect(insertOffer(orderId, otherMasterId)).resolves.toBeDefined();
    });

    it('lets the same master be offered two different orders', async () => {
      const fixture = await makeFixture();
      const otherOrderId = await insertOrder(fixture);
      const orderId = await insertOrder(fixture);

      await insertOffer(orderId, fixture.masterId);
      await expect(insertOffer(otherOrderId, fixture.masterId)).resolves.toBeDefined();
    });
  });

  describe('round, radius and distance', () => {
    it('refuses a round below 1', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(insertOffer(orderId, fixture.masterId, { round: 0 })).rejects.toThrow(
        /order_offers_round_positive/,
      );
    });

    it('refuses a radius that is zero or negative', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      for (const radiusM of [0, -1]) {
        await expect(insertOffer(orderId, fixture.masterId, { radiusM })).rejects.toThrow(
          /order_offers_radius_positive/,
        );
      }
    });

    it('refuses a negative distance but accepts zero', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(insertOffer(orderId, fixture.masterId, { distanceM: -1 })).rejects.toThrow(
        /order_offers_distance_non_negative/,
      );
      await expect(insertOffer(orderId, fixture.masterId, { distanceM: 0 })).resolves.toBeDefined();
    });
  });

  describe('response consistency', () => {
    it('refuses a declined row with no responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, { status: 'declined', respondedAt: null }),
      ).rejects.toThrow(/order_offers_response_consistent/);
    });

    it('refuses an accepted row with no responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, { status: 'accepted', respondedAt: null }),
      ).rejects.toThrow(/order_offers_response_consistent/);
    });

    it('refuses a lost row with no responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, { status: 'lost', respondedAt: null }),
      ).rejects.toThrow(/order_offers_response_consistent/);
    });

    it('refuses an offered row that carries a responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, {
          status: 'offered',
          respondedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/order_offers_response_consistent/);
    });

    it('refuses an expired row that carries a responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, {
          status: 'expired',
          respondedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/order_offers_response_consistent/);
    });

    it('accepts a declined row that carries a responded_at', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertOffer(orderId, fixture.masterId, {
          status: 'declined',
          respondedAt: new Date().toISOString(),
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('the offer feed and per-order reads use their indexes', () => {
    it("serves a master's live offers without scanning the table", async () => {
      const fixture = await makeFixture();
      for (let i = 0; i < 5; i += 1) {
        await insertOffer(await insertOrder(fixture), fixture.masterId);
      }

      const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM order_offers WHERE master_id = $1 AND status = 'offered' ORDER BY created_at DESC`,
        [fixture.masterId],
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/order_offers_master_status_created_idx/);
    });

    it("serves one order's offers without scanning the table", async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      const otherMaster = await insertMaster();
      await insertOffer(orderId, fixture.masterId);
      await insertOffer(orderId, otherMaster);

      const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM order_offers WHERE order_id = $1`,
        [orderId],
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/order_offers_order_master_unique/);
    });
  });

  describe('nothing deletes an order or a master out from under its offers', () => {
    it('refuses to hard-delete an order that has an offer', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await insertOffer(orderId, fixture.masterId);

      await expect(pool.query(`DELETE FROM orders WHERE id = $1`, [orderId])).rejects.toThrow(
        /violates foreign key constraint/,
      );
    });

    it('refuses to hard-delete a master who has an offer', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await insertOffer(orderId, fixture.masterId);

      await expect(
        pool.query(`DELETE FROM masters WHERE id = $1`, [fixture.masterId]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });
});
