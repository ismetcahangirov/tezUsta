import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SERVICE_CATALOGUE_SEED } from '../src/infra/database/seed/service-catalogue.seed-data';
import { runSeed } from '../src/infra/database/seed';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The ten launch categories, in the order `docs/product/product-overview.md`
 * § Service categories lists them. Written out rather than derived from the
 * seed file, because the claim under test is "the seed matches the product
 * document" — deriving the expectation from the thing being tested would make
 * this assertion true by construction and worth nothing.
 */
const LAUNCH_CATEGORY_SLUGS = [
  'plumbing',
  'locks',
  'electrical',
  'air-conditioning',
  'appliance-repair',
  'small-construction',
  'furniture-assembly',
  'painting',
  'cleaning',
  'other',
];

const A_CATEGORY_ID = '01900000-0000-7000-8000-00000000c001';
const A_MISSING_CATEGORY_ID = '01900000-0000-7000-8000-0000deadbeef';

describe('the service catalogue schema and its launch seed', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('loads the ten launch categories, in the order the product document lists them', async () => {
    const { rows } = await pool.query<{ slug: string }>(
      'SELECT slug FROM service_categories ORDER BY display_order, id',
    );

    expect(rows.map((row) => row.slug)).toEqual(LAUNCH_CATEGORY_SLUGS);
  });

  it('gives every launch category at least one service, and leaves none stranded', async () => {
    const { rows } = await pool.query<{ slug: string; service_count: string }>(
      `SELECT c.slug, count(s.id)::text AS service_count
         FROM service_categories c
         LEFT JOIN services s ON s.category_id = c.id
        GROUP BY c.slug`,
    );

    const countBySlug = new Map(rows.map((row) => [row.slug, Number(row.service_count)]));
    for (const category of SERVICE_CATALOGUE_SEED) {
      expect(countBySlug.get(category.slug)).toBe(category.services.length);
    }
  });

  it('stores an Azerbaijani display name for every row, which is what a read falls back to', async () => {
    const { rows } = await pool.query<{ untranslated: string }>(
      `SELECT count(*)::text AS untranslated
         FROM services
        WHERE btrim(name ->> 'az') = '' OR name ->> 'az' IS NULL`,
    );

    expect(Number(rows[0]?.untranslated)).toBe(0);
  });

  it('inserts nothing on a second run, so it is safe next to db:migrate in a deploy', async () => {
    const before = await pool.query<{ total: string }>(
      'SELECT (SELECT count(*) FROM service_categories) + (SELECT count(*) FROM services) AS total',
    );

    await runSeed(database.url);

    const after = await pool.query<{ total: string }>(
      'SELECT (SELECT count(*) FROM service_categories) + (SELECT count(*) FROM services) AS total',
    );

    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });

  it('will not overwrite a price an admin has corrected', async () => {
    await pool.query(`UPDATE services SET base_price_minor = 9999 WHERE slug = 'leak-repair'`);

    await runSeed(database.url);

    const { rows } = await pool.query<{ base_price_minor: string }>(
      `SELECT base_price_minor FROM services WHERE slug = 'leak-repair'`,
    );
    expect(Number(rows[0]?.base_price_minor)).toBe(9999);
  });

  it('refuses a service that points at a category which does not exist', async () => {
    await expect(
      pool.query(
        `INSERT INTO services (id, category_id, slug, name, pricing_kind, base_price_minor)
         VALUES ($1, $2, 'orphan-service', '{"az":"Sahibsiz"}', 'fixed', 1000)`,
        ['01900000-0000-7000-8000-00000000a001', A_MISSING_CATEGORY_ID],
      ),
    ).rejects.toThrow(/services_category_id_service_categories_id_fk/);
  });

  it('refuses an inspection-priced service that carries a price', async () => {
    await expect(
      pool.query(
        `INSERT INTO services (id, category_id, slug, name, pricing_kind, base_price_minor)
         SELECT $1, id, 'priced-inspection', '{"az":"Baxış"}', 'inspection', 1500
           FROM service_categories WHERE slug = 'plumbing'`,
        ['01900000-0000-7000-8000-00000000a002'],
      ),
    ).rejects.toThrow(/services_pricing_shape/);
  });

  it('refuses a fixed-price service with no price', async () => {
    await expect(
      pool.query(
        `INSERT INTO services (id, category_id, slug, name, pricing_kind, base_price_minor)
         SELECT $1, id, 'priceless-fixed', '{"az":"Qiymətsiz"}', 'fixed', NULL
           FROM service_categories WHERE slug = 'plumbing'`,
        ['01900000-0000-7000-8000-00000000a003'],
      ),
    ).rejects.toThrow(/services_pricing_shape/);
  });

  it('refuses a display name with no Azerbaijani fallback', async () => {
    await expect(
      pool.query(
        `INSERT INTO service_categories (id, slug, name) VALUES ($1, 'english-only', '{"en":"English only"}')`,
        [A_CATEGORY_ID],
      ),
    ).rejects.toThrow(/service_categories_name_has_fallback/);
  });

  it('refuses a display name that is not a translation map at all', async () => {
    await expect(
      pool.query(
        `INSERT INTO service_categories (id, slug, name) VALUES ($1, 'bare-string', '"Santexnika"')`,
        [A_CATEGORY_ID],
      ),
    ).rejects.toThrow(/service_categories_name_has_fallback/);
  });

  it('keeps a deactivated service readable, so an order that references it still resolves', async () => {
    const { rows: before } = await pool.query<{ id: string }>(
      `SELECT id FROM services WHERE slug = 'window-cleaning'`,
    );
    const serviceId = before[0]?.id;
    expect(serviceId).toBeDefined();

    await pool.query('UPDATE services SET is_active = false WHERE id = $1', [serviceId]);

    const { rows: after } = await pool.query<{ id: string; category_id: string }>(
      'SELECT id, category_id FROM services WHERE id = $1',
      [serviceId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.category_id).toBeTruthy();

    const { rows: listed } = await pool.query<{ slug: string }>(
      `SELECT slug FROM services WHERE is_active AND slug = 'window-cleaning'`,
    );
    expect(listed).toHaveLength(0);
  });

  it('refuses to delete a category that still has services, rather than cascading', async () => {
    await expect(
      pool.query(`DELETE FROM service_categories WHERE slug = 'plumbing'`),
    ).rejects.toThrow(/services_category_id_service_categories_id_fk/);
  });
});

describe('the catalogue listing queries', () => {
  let database: ThrowawayDatabase;
  let pool: Pool;

  /**
   * The seeded catalogue is ~35 rows, and on 35 rows a sequential scan is
   * genuinely the cheapest plan — an EXPLAIN against it would assert nothing
   * except that the planner can count. These tests therefore load the table to
   * a size where the index is the *right* answer, and then check that the
   * planner agrees. `enable_seqscan = off` would have produced a green test on
   * a missing index, which is the failure mode this is guarding against.
   */
  const FILLER_SERVICE_COUNT = 5_000;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    pool = new Pool({ connectionString: database.url });

    // Spread across every category, not piled into one. A category predicate
    // that matches most of the table is a predicate the planner is right to
    // ignore, and the test would then be asserting the planner's mistake
    // rather than the index's existence.
    await pool.query(
      `WITH cats AS (
         SELECT id,
                row_number() OVER (ORDER BY display_order, id) - 1 AS ord,
                count(*) OVER () AS total
           FROM service_categories
       )
       INSERT INTO services (id, category_id, slug, name, pricing_kind, base_price_minor, display_order, is_active)
       SELECT
         ('0190' || lpad(to_hex(n), 4, '0') || '-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
         cats.id,
         'filler-' || n,
         jsonb_build_object('az', 'Doldurucu ' || n),
         'fixed',
         1000 + n,
         n,
         n % 3 <> 0
       FROM generate_series(1, $1) AS n
       JOIN cats ON cats.ord = n % cats.total`,
      [FILLER_SERVICE_COUNT],
    );
    await pool.query('ANALYZE services, service_categories');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  it('reads active services in display order through the partial index', async () => {
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, slug FROM services WHERE is_active ORDER BY display_order, id LIMIT 20`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Index Scan using services_active_order_idx/);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  /**
   * The same listing as the application actually runs it — joined to
   * `service_categories`, because a service under a deactivated category must
   * not be listed (ADR-0020).
   *
   * The test above proves the index serves the sort; this one proves the join
   * did not quietly cost that. `Seq Scan on service_categories` is expected
   * and correct — ten rows are cheaper to read than to seek — so the
   * assertions name `services`, which is the table that grows.
   */
  it('reads the joined listing without scanning or sorting the services table', async () => {
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT s.id, s.slug FROM services s
         JOIN service_categories c ON c.id = s.category_id
        WHERE s.is_active AND c.is_active
        ORDER BY s.display_order, s.id LIMIT 20`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Index Scan using services_active_order_idx/);
    expect(plan).not.toMatch(/Seq Scan on services/);
    expect(plan).not.toMatch(/Sort/);
  });

  /**
   * Deliberately not asserting *which* index this plan picks.
   *
   * With ten categories the two partial indexes cost within a few percent of
   * each other, and Postgres reasonably prefers the narrower
   * `services_active_order_idx` with a category filter on top — measured, not
   * assumed. Pinning the index name here would encode one planner's estimate
   * on one data distribution and fail on a catalogue with fifty categories,
   * where the other plan wins and is *also* correct.
   *
   * What must hold either way is CLAUDE.md §12: the hot path neither scans the
   * table nor sorts it. Both of those are visible in the plan, and both are
   * what a missing index would produce.
   */
  it('reads one category of active services without scanning or sorting the table', async () => {
    const { rows: category } = await pool.query<{ id: string }>(
      `SELECT id FROM service_categories WHERE slug = 'other'`,
    );

    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, slug FROM services
        WHERE is_active AND category_id = $1
        ORDER BY display_order, id LIMIT 20`,
      [category[0]?.id],
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Index Scan/);
    expect(plan).not.toMatch(/Seq Scan/);
    expect(plan).not.toMatch(/Sort/);
  });

  /**
   * Postgres indexes a primary key automatically and a foreign key never.
   * Without this index the referential-integrity check Postgres runs whenever
   * a `service_categories` row is updated or deleted is a full scan of
   * `services` — a cost that shows up in an admin action, not in a request,
   * which is exactly why nobody notices it until the table is large.
   */
  it('indexes the foreign key, which Postgres does not do on its own', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'services'`,
    );

    expect(rows.map((row) => row.indexdef).join('\n')).toMatch(/\(category_id[,)]/);
  });
});
