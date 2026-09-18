import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The database-level half of issue #80.
 *
 * `order-lifecycle.test.ts` proves the state machine refuses the transitions
 * ADR-0015 does not contain. That check runs on the request path only, so it
 * says nothing about what the *table* will accept — and the rules that matter
 * most here (one active order per master, a price with no master, an audit
 * trail that cannot be rewritten) have to hold against a seed script, a
 * migration, a support query and whatever admin tooling arrives later.
 *
 * A constraint nobody tested is a constraint nobody knows fires.
 */

interface Fixture {
  readonly userId: string;
  readonly customerId: string;
  readonly addressId: string;
  readonly masterId: string;
  readonly serviceId: string;
}

describe('the orders schema constraints (issue #80)', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let phoneCounter = 0;

  function nextPhone(): string {
    phoneCounter += 1;
    return `+99450${String(phoneCounter).padStart(7, '0')}`;
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
      `INSERT INTO masters (id, user_id, display_name)
       VALUES (gen_random_uuid(), $1, 'Rəşad') RETURNING id`,
      [userId],
    );
    return required(rows[0]?.id, 'master');
  }

  async function makeFixture(): Promise<Fixture> {
    const userId = await insertUser();
    const customerId = await insertCustomer(userId);
    return {
      userId,
      customerId,
      addressId: await insertAddress(customerId),
      masterId: await insertMaster(),
      serviceId,
    };
  }

  function required(value: string | undefined, what: string): string {
    if (value === undefined) {
      throw new Error(`Failed to insert the test ${what}.`);
    }
    return value;
  }

  async function insertOrder(
    fixture: Fixture,
    overrides: {
      status?: string;
      masterId?: string | null;
      priceMinor?: number | null;
      acceptedAt?: string | null;
      description?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (id, customer_id, address_id, service_id, master_id, status,
                           description, price_minor, accepted_at, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::order_status, $6, $7, $8, $9)
       RETURNING id`,
      [
        fixture.customerId,
        fixture.addressId,
        fixture.serviceId,
        overrides.masterId === undefined ? null : overrides.masterId,
        overrides.status ?? 'DRAFT',
        overrides.description ?? 'Mətbəxdə kran sızır və su axır.',
        overrides.priceMinor ?? null,
        overrides.acceptedAt ?? null,
        overrides.idempotencyKey ?? `key-${crypto.randomUUID()}`,
      ],
    );
    return required(rows[0]?.id, 'order');
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

  describe('an order at rest', () => {
    it('starts with no master, no price and no accept time', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);

      const { rows } = await pool.query<{
        status: string;
        master_id: string | null;
        price_minor: string | null;
        accepted_at: Date | null;
        redispatch_count: number;
      }>(
        `SELECT status, master_id, price_minor, accepted_at, redispatch_count
           FROM orders WHERE id = $1`,
        [orderId],
      );

      expect(rows[0]).toMatchObject({
        status: 'DRAFT',
        master_id: null,
        price_minor: null,
        accepted_at: null,
        redispatch_count: 0,
      });
    });

    it('accepts a searching order with no price, which is the whole point of ADR-0013', async () => {
      const fixture = await makeFixture();
      await expect(insertOrder(fixture, { status: 'SEARCHING' })).resolves.toBeDefined();
    });

    it('refuses a status that is not one of the fourteen', async () => {
      const fixture = await makeFixture();
      await expect(insertOrder(fixture, { status: 'ON_THE_WAY' })).rejects.toThrow(
        /invalid input value for enum/i,
      );
    });
  });

  describe('price and master are one fact (ADR-0013)', () => {
    it('refuses a price on an order nobody has accepted', async () => {
      const fixture = await makeFixture();
      await expect(insertOrder(fixture, { status: 'SEARCHING', priceMinor: 4500 })).rejects.toThrow(
        /orders_price_requires_master/,
      );
    });

    it('refuses an accept time on an order nobody has accepted', async () => {
      const fixture = await makeFixture();
      await expect(
        insertOrder(fixture, { status: 'SEARCHING', acceptedAt: new Date().toISOString() }),
      ).rejects.toThrow(/orders_accepted_at_requires_master/);
    });

    it('allows a price once a master is assigned', async () => {
      const fixture = await makeFixture();
      await expect(
        insertOrder(fixture, {
          status: 'ACCEPTED',
          masterId: fixture.masterId,
          priceMinor: 4500,
          acceptedAt: new Date().toISOString(),
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a free job and a negative one alike', async () => {
      const fixture = await makeFixture();
      for (const priceMinor of [0, -100]) {
        await expect(
          insertOrder(fixture, {
            status: 'ACCEPTED',
            masterId: fixture.masterId,
            priceMinor,
          }),
        ).rejects.toThrow(/orders_price_positive/);
      }
    });
  });

  describe('the description is bounded in the table, not only in the request schema', () => {
    it('refuses an empty or whitespace-only description', async () => {
      const fixture = await makeFixture();
      for (const description of ['', '   ']) {
        await expect(insertOrder(fixture, { description })).rejects.toThrow(
          /orders_description_length/,
        );
      }
    });

    it('refuses a description past the cap', async () => {
      const fixture = await makeFixture();
      await expect(insertOrder(fixture, { description: 'ə'.repeat(2001) })).rejects.toThrow(
        /orders_description_length/,
      );
    });
  });

  describe('idempotency is a constraint, not a check-then-write', () => {
    it('refuses a second order with the same key for the same customer', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture, { idempotencyKey: 'retry-me' });
      await expect(insertOrder(fixture, { idempotencyKey: 'retry-me' })).rejects.toThrow(
        /orders_customer_idempotency_key_unique/,
      );
    });

    it('lets two different customers pick the same key, because that is a coincidence', async () => {
      const first = await makeFixture();
      const second = await makeFixture();
      await insertOrder(first, { idempotencyKey: 'same-key' });
      await expect(insertOrder(second, { idempotencyKey: 'same-key' })).resolves.toBeDefined();
    });
  });

  describe('a master holds at most one active order', () => {
    it('refuses a second active order for the same master', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture, { status: 'ACCEPTED', masterId: fixture.masterId });
      await expect(
        insertOrder(fixture, { status: 'IN_PROGRESS', masterId: fixture.masterId }),
      ).rejects.toThrow(/orders_one_active_per_master/);
    });

    it('lets the same master take another order once the first one has finished', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture, { status: 'COMPLETED', masterId: fixture.masterId });
      await expect(
        insertOrder(fixture, { status: 'ACCEPTED', masterId: fixture.masterId }),
      ).resolves.toBeDefined();
    });

    /**
     * The sequential case above would also pass against an application-level
     * check. This one would not: both inserts are in flight before either
     * commits, which is exactly the shape of two masters' accepts arriving
     * together, and only the index can decide it.
     */
    it('lets exactly one of two simultaneous active orders through', async () => {
      const fixture = await makeFixture();
      const results = await Promise.allSettled([
        insertOrder(fixture, { status: 'ACCEPTED', masterId: fixture.masterId }),
        insertOrder(fixture, { status: 'ACCEPTED', masterId: fixture.masterId }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });

    it('does not treat two searching orders as a collision, since neither has a master', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture, { status: 'SEARCHING' });
      await expect(insertOrder(fixture, { status: 'SEARCHING' })).resolves.toBeDefined();
    });
  });

  describe('order_status_history', () => {
    async function insertHistory(
      orderId: string,
      row: {
        from?: string;
        to?: string;
        actorKind: string;
        actorUserId?: string | null;
        actorAdminId?: string | null;
        reason?: string | null;
      },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO order_status_history
           (id, order_id, from_status, to_status, actor_kind, actor_user_id, actor_admin_id, reason)
         VALUES (gen_random_uuid(), $1, $2::order_status, $3::order_status,
                 $4::order_actor_kind, $5, $6, $7)`,
        [
          orderId,
          row.from ?? 'DRAFT',
          row.to ?? 'SEARCHING',
          row.actorKind,
          row.actorUserId ?? null,
          row.actorAdminId ?? null,
          row.reason ?? null,
        ],
      );
    }

    it('records a system transition that names nobody', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(insertHistory(orderId, { actorKind: 'system' })).resolves.toBeUndefined();
    });

    it('requires a user behind a customer or master transition', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      for (const actorKind of ['customer', 'master']) {
        await expect(insertHistory(orderId, { actorKind })).rejects.toThrow(
          /order_status_history_actor_shape/,
        );
      }
    });

    it('refuses a system transition that names somebody', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertHistory(orderId, { actorKind: 'system', actorUserId: fixture.userId }),
      ).rejects.toThrow(/order_status_history_actor_shape/);
    });

    it('refuses a transition from a status to itself', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await expect(
        insertHistory(orderId, { from: 'SEARCHING', to: 'SEARCHING', actorKind: 'system' }),
      ).rejects.toThrow(/order_status_history_real_transition/);
    });

    it('cannot be updated, deleted or truncated — the trail is the record', async () => {
      const fixture = await makeFixture();
      const orderId = await insertOrder(fixture);
      await insertHistory(orderId, { actorKind: 'system' });

      await expect(
        pool.query(`UPDATE order_status_history SET reason = 'tidied up' WHERE order_id = $1`, [
          orderId,
        ]),
      ).rejects.toThrow(/append-only/);

      await expect(
        pool.query(`DELETE FROM order_status_history WHERE order_id = $1`, [orderId]),
      ).rejects.toThrow(/append-only/);

      await expect(pool.query(`TRUNCATE order_status_history`)).rejects.toThrow(/append-only/);
    });
  });

  describe('nothing deletes an order out from under its history', () => {
    it('refuses to hard-delete a customer who has an order', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture);
      await expect(
        pool.query(`DELETE FROM customers WHERE id = $1`, [fixture.customerId]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses to hard-delete the address an order points at', async () => {
      const fixture = await makeFixture();
      await insertOrder(fixture);
      await expect(
        pool.query(`DELETE FROM addresses WHERE id = $1`, [fixture.addressId]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });
});
