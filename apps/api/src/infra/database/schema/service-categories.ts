import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { LocalizedText } from '../../../common/i18n/localized-text.types';

/**
 * The top level of the service catalogue — the ten launch categories in
 * `docs/product/product-overview.md` § Service categories.
 *
 * **The catalogue is data, not code** (EPIC 3). Adding a category must never
 * require an app release, so nothing here is mirrored in a TypeScript union,
 * a mobile constant, or a seeded enum: the app renders whatever these rows
 * say. That is also why `slug` exists alongside `id` — a deployment-stable
 * handle a seed script, a support conversation, or a future admin import can
 * name, without anybody pasting a UUID.
 *
 * **Rows are deactivated, never deleted.** An order placed last month
 * references a service in this tree, and a `DELETE` would either orphan that
 * history or cascade it away. `is_active = false` keeps the row readable for
 * everything that already points at it while removing it from every
 * customer-facing list.
 */
export const serviceCategories = pgTable(
  'service_categories',
  {
    id: uuid('id').primaryKey(),

    /**
     * Lowercase kebab-case, unique across the table, and stable forever. It is
     * the key the seed script upserts on, so changing one is not a rename but
     * the creation of a second category.
     */
    slug: text('slug').notNull(),

    /**
     * Every translation of the display name, keyed by locale — see
     * `common/i18n/localized-text.types.ts` and ADR-0018. The CHECK below is
     * what makes `LocalizedText`'s required `az` true of the data and not only
     * of the type.
     */
    name: jsonb('name').$type<LocalizedText>().notNull(),

    /**
     * Ascending. Ties break on `id`, which is UUIDv7 and therefore insertion
     * ordered, so two categories that share an order still list in a stable
     * sequence rather than whatever the planner returns that day.
     */
    displayOrder: integer('display_order').notNull().default(0),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('service_categories_slug_unique').on(table.slug),

    /**
     * The only query a customer-facing read makes: active categories in
     * display order. Partial on `is_active` so the index holds exactly the
     * rows the listing returns, and carrying `display_order, id` so the sort
     * is satisfied by the scan rather than by a sort node on top of it.
     */
    index('service_categories_active_order_idx')
      .on(table.displayOrder, table.id)
      .where(sql`${table.isActive}`),

    /**
     * `az` is the fallback locale every read resolves to. A row missing it
     * renders as an empty string in the app — a blank row in a list, with no
     * error anywhere to explain it — so the database refuses the row instead.
     * `jsonb_typeof` is here because `jsonb` accepts `"a string"` and `[1,2]`
     * as perfectly valid documents, and neither is a translation map.
     */
    check(
      'service_categories_name_has_fallback',
      sql`jsonb_typeof(${table.name}) = 'object' and jsonb_exists(${table.name}, 'az') and length(btrim(${table.name} ->> 'az')) > 0`,
    ),

    check('service_categories_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export type ServiceCategoryRow = typeof serviceCategories.$inferSelect;
export type NewServiceCategoryRow = typeof serviceCategories.$inferInsert;
