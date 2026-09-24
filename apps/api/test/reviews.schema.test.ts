import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The database-level half of issue #221 (ADR-0042 § Integrity).
 *
 * Nothing writes to `reviews` yet — submission is issue #222, built on this
 * table — so everything here goes through raw SQL, the way
 * `order-offers.schema.test.ts` proves its table before a service exists. The
 * rule that matters most, "a review is about exactly the two parties of its
 * order", has to hold against whatever writes here first, including a script
 * or an admin tool that never passes through the service.
 */

interface Order {
  readonly orderId: string;
  readonly customerId: string;
  readonly masterId: string;
}

interface ReviewInput {
  readonly orderId: string;
  readonly customerId: string;
  readonly masterId: string;
  readonly authorRole?: string;
  readonly rating?: number;
  readonly comment?: string | null;
  readonly removedAt?: string | null;
  readonly removedByAdminId?: string | null;
  readonly removalReason?: string | null;
}

describe('the reviews schema constraints (issue #221)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let counter = 0;

  function required<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(`Failed to insert the test ${what}.`);
    }
    return value;
  }

  function nextPhone(): string {
    counter += 1;
    return `+99452${String(counter).padStart(7, '0')}`;
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

  async function insertMaster(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO masters (id, user_id, display_name)
       VALUES (gen_random_uuid(), $1, 'Rəşad') RETURNING id`,
      [await insertUser()],
    );
    return required(rows[0]?.id, 'master');
  }

  async function insertAdminUser(): Promise<string> {
    counter += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (id, email, display_name)
       VALUES (gen_random_uuid(), $1, 'Admin') RETURNING id`,
      [`admin-${String(counter)}-${Date.now().toString(36)}@tezusta.az`],
    );
    return required(rows[0]?.id, 'admin user');
  }

  /** A completed order between a fresh customer and a fresh master. */
  async function insertCompletedOrder(): Promise<Order> {
    const customerId = await insertCustomer();
    const masterId = await insertMaster();
    const address = await pool.query<{ id: string }>(
      `INSERT INTO addresses (id, customer_id, formatted_address, position)
       VALUES (gen_random_uuid(), $1, 'Bakı, Nizami küçəsi 1',
               ST_SetSRID(ST_MakePoint(49.8671, 40.4093), 4326))
       RETURNING id`,
      [customerId],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (id, customer_id, address_id, service_id, master_id, status, description,
                           idempotency_key, accepted_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', 'Mətbəxdə kran sızır.', $5, now())
       RETURNING id`,
      [
        customerId,
        required(address.rows[0]?.id, 'address'),
        serviceId,
        masterId,
        `key-${crypto.randomUUID()}`,
      ],
    );
    return { orderId: required(rows[0]?.id, 'order'), customerId, masterId };
  }

  async function insertReview(input: ReviewInput): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reviews (id, order_id, customer_id, master_id, author_role, rating, comment,
                            removed_at, removed_by_admin_id, removal_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::review_author_role, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.orderId,
        input.customerId,
        input.masterId,
        input.authorRole ?? 'customer',
        input.rating ?? 5,
        input.comment === undefined ? null : input.comment,
        input.removedAt ?? null,
        input.removedByAdminId ?? null,
        input.removalReason ?? null,
      ],
    );
    return required(rows[0]?.id, 'review');
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

  it('stores one review from each side of a completed order, sealed by default', async () => {
    const order = await insertCompletedOrder();
    const fromCustomer = await insertReview({ ...order, authorRole: 'customer', rating: 4 });
    const fromMaster = await insertReview({
      ...order,
      authorRole: 'master',
      rating: 5,
      comment: 'Nəzakətli müştəri.',
    });

    const { rows } = await pool.query<{ id: string; revealed_at: Date | null }>(
      `SELECT id, revealed_at FROM reviews WHERE order_id = $1 ORDER BY author_role`,
      [order.orderId],
    );
    expect(rows.map((row) => row.id).sort()).toEqual([fromCustomer, fromMaster].sort());
    expect(rows.every((row) => row.revealed_at === null)).toBe(true);
  });

  describe('a review is about exactly the two parties of its order', () => {
    it('refuses a customer who is not the order’s customer', async () => {
      const order = await insertCompletedOrder();
      const stranger = await insertCustomer();
      await expect(insertReview({ ...order, customerId: stranger })).rejects.toThrow(
        /reviews_order_parties_fk/,
      );
    });

    it('refuses a master who is not the order’s master', async () => {
      const order = await insertCompletedOrder();
      const stranger = await insertMaster();
      await expect(insertReview({ ...order, masterId: stranger })).rejects.toThrow(
        /reviews_order_parties_fk/,
      );
    });

    it('refuses a real pair of people borrowing somebody else’s order', async () => {
      const theirs = await insertCompletedOrder();
      const ours = await insertCompletedOrder();
      await expect(
        insertReview({
          orderId: theirs.orderId,
          customerId: ours.customerId,
          masterId: ours.masterId,
        }),
      ).rejects.toThrow(/reviews_order_parties_fk/);
    });

    it('refuses an order that does not exist', async () => {
      const order = await insertCompletedOrder();
      await expect(insertReview({ ...order, orderId: crypto.randomUUID() })).rejects.toThrow(
        /reviews_order_parties_fk/,
      );
    });

    it('refuses to delete an order that has a review', async () => {
      const order = await insertCompletedOrder();
      await insertReview(order);
      await expect(pool.query(`DELETE FROM orders WHERE id = $1`, [order.orderId])).rejects.toThrow(
        /reviews_order_parties_fk/,
      );
    });

    it('refuses to move an order to another master once it has a review', async () => {
      const order = await insertCompletedOrder();
      await insertReview(order);
      const otherMaster = await insertMaster();
      await expect(
        pool.query(`UPDATE orders SET master_id = $2 WHERE id = $1`, [order.orderId, otherMaster]),
      ).rejects.toThrow(/reviews_order_parties_fk/);
    });
  });

  it('refuses a second review by the same side of one order', async () => {
    const order = await insertCompletedOrder();
    await insertReview({ ...order, authorRole: 'master' });
    await expect(insertReview({ ...order, authorRole: 'master', rating: 1 })).rejects.toThrow(
      /reviews_order_author_unique/,
    );
  });

  it('refuses an author role outside the two sides', async () => {
    const order = await insertCompletedOrder();
    await expect(insertReview({ ...order, authorRole: 'admin' })).rejects.toThrow(
      /invalid input value for enum/i,
    );
  });

  describe('rating', () => {
    it.each([0, 6, -1])('refuses %i', async (rating) => {
      const order = await insertCompletedOrder();
      await expect(insertReview({ ...order, rating })).rejects.toThrow(/reviews_rating_range/);
    });

    it.each([1, 5])('accepts %i', async (rating) => {
      const order = await insertCompletedOrder();
      await expect(insertReview({ ...order, rating })).resolves.toBeDefined();
    });
  });

  describe('comment', () => {
    it('accepts exactly 500 characters, counted as characters rather than bytes', async () => {
      const order = await insertCompletedOrder();
      await expect(insertReview({ ...order, comment: 'ə'.repeat(500) })).resolves.toBeDefined();
    });

    it('refuses 501 characters', async () => {
      const order = await insertCompletedOrder();
      await expect(insertReview({ ...order, comment: 'a'.repeat(501) })).rejects.toThrow(
        /reviews_comment_length/,
      );
    });

    it('refuses an empty or whitespace-only comment, which is stored as null instead', async () => {
      const order = await insertCompletedOrder();
      for (const comment of ['', '   ']) {
        await expect(insertReview({ ...order, comment })).rejects.toThrow(/reviews_comment_length/);
      }
    });
  });

  describe('removal is all three columns or none', () => {
    it('accepts a complete removal', async () => {
      const order = await insertCompletedOrder();
      const adminId = await insertAdminUser();
      await expect(
        insertReview({
          ...order,
          removedAt: new Date().toISOString(),
          removedByAdminId: adminId,
          removalReason: 'Təhqiramiz ifadə.',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a removal with no admin', async () => {
      const order = await insertCompletedOrder();
      await expect(
        insertReview({
          ...order,
          removedAt: new Date().toISOString(),
          removalReason: 'Təhqiramiz ifadə.',
        }),
      ).rejects.toThrow(/reviews_removal_complete/);
    });

    it('refuses a removal with no reason', async () => {
      const order = await insertCompletedOrder();
      const adminId = await insertAdminUser();
      await expect(
        insertReview({
          ...order,
          removedAt: new Date().toISOString(),
          removedByAdminId: adminId,
        }),
      ).rejects.toThrow(/reviews_removal_complete/);
    });

    it('refuses a reason and an admin with no removal moment', async () => {
      const order = await insertCompletedOrder();
      const adminId = await insertAdminUser();
      await expect(
        insertReview({ ...order, removedByAdminId: adminId, removalReason: 'Səbəb.' }),
      ).rejects.toThrow(/reviews_removal_complete/);
    });

    it('refuses a removal naming an admin that does not exist', async () => {
      const order = await insertCompletedOrder();
      await expect(
        insertReview({
          ...order,
          removedAt: new Date().toISOString(),
          removedByAdminId: crypto.randomUUID(),
          removalReason: 'Səbəb.',
        }),
      ).rejects.toThrow(/reviews_removed_by_admin_id_admin_users_id_fk/);
    });
  });

  describe('the customer rating aggregate', () => {
    it('starts every customer at no rating', async () => {
      const customerId = await insertCustomer();
      const { rows } = await pool.query<{ rating_sum: number; rating_count: number }>(
        `SELECT rating_sum, rating_count FROM customers WHERE id = $1`,
        [customerId],
      );
      expect(rows[0]).toEqual({ rating_sum: 0, rating_count: 0 });
    });

    it('accepts a pair a real set of one-to-five ratings could produce', async () => {
      const customerId = await insertCustomer();
      await expect(
        pool.query(`UPDATE customers SET rating_sum = 9, rating_count = 2 WHERE id = $1`, [
          customerId,
        ]),
      ).resolves.toBeDefined();
    });

    it.each([
      ['a sum above five per review', 11, 2],
      ['a sum with no reviews', 3, 0],
      ['a negative count', 0, -1],
      ['a negative sum', -1, 1],
    ])('refuses %s', async (_label, sum, count) => {
      const customerId = await insertCustomer();
      await expect(
        pool.query(`UPDATE customers SET rating_sum = $2, rating_count = $3 WHERE id = $1`, [
          customerId,
          sum,
          count,
        ]),
      ).rejects.toThrow(/customers_rating_aggregate/);
    });
  });
});
