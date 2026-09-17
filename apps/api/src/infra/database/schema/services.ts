import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { LocalizedText } from '../../../common/i18n/localized-text.types';
import { serviceCategories } from './service-categories';

/**
 * How a service's price comes to exist.
 *
 * - `fixed` — the work is known in advance, so a reference figure can be
 *   quoted before anybody visits ("from 15 AZN").
 * - `inspection` — the work cannot be priced until a master has seen it. A
 *   fridge that will not cool is a compressor or a thermostat or a door seal,
 *   and quoting any number before the visit is a number that will change.
 *
 * The two are a closed set decided by the product, not free text, so they are
 * a Postgres enum: a typo in an admin panel becomes a rejected write instead
 * of a third pricing shape nothing in the app knows how to render.
 */
export const servicePricingKind = pgEnum('service_pricing_kind', ['fixed', 'inspection']);

/**
 * A single orderable job inside a category.
 *
 * **`base_price_minor` is a reference price, not the price of an order**
 * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)). The master
 * sets the authoritative figure on their own `master_services` row (EPIC 5),
 * and the order freezes a copy of it at accept
 * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)). What lives here
 * is what the app shows a customer who has not chosen a master yet.
 *
 * Deactivation, not deletion, for the reason given on `service_categories`:
 * an existing order references this row.
 */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),

    /**
     * `onDelete: 'restrict'` rather than `cascade`. Deleting a category that
     * still has services is a mistake every time — the intent is always
     * deactivation — and a cascade would carry that mistake into whatever
     * references the services, silently.
     */
    categoryId: uuid('category_id')
      .notNull()
      .references(() => serviceCategories.id, { onDelete: 'restrict' }),

    /** Unique across the whole table, not per category. See `service_categories.slug`. */
    slug: text('slug').notNull(),

    name: jsonb('name').$type<LocalizedText>().notNull(),

    pricingKind: servicePricingKind('pricing_kind').notNull(),

    /**
     * Integer **minor units** — 15.00 AZN is `1500`, never `15.0`
     * (`docs/architecture/database-architecture.md` § Conventions, ADR-0010).
     *
     * `mode: 'number'` rather than `'bigint'`: AZN minor units for a household
     * repair cannot approach 2^53, and a JavaScript `BigInt` cannot be passed
     * to `JSON.stringify` at all — every response path would need a conversion
     * that exists only to undo this choice.
     *
     * Null for an `inspection` service, and the CHECK below makes that the
     * only possibility rather than a convention somebody eventually forgets.
     */
    basePriceMinor: bigint('base_price_minor', { mode: 'number' }),

    /**
     * Position in the **catalogue**, not inside the category (issue #65).
     *
     * The unfiltered listing sorts by `(display_order, id)` across the whole
     * table, so a per-category index here made every category's first service
     * sort ahead of every category's second and the list came back
     * interleaved. The seed writes one sequence that keeps running across
     * categories; grouping is then a consequence of the values rather than of
     * a join the query would otherwise have to sort on.
     *
     * Ties are allowed — two services may deliberately share an order — which
     * is why `id` is part of every sort and every cursor.
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
    uniqueIndex('services_slug_unique').on(table.slug),

    /**
     * Postgres does not index a foreign key automatically. Without this, every
     * "services in this category" read is a sequential scan of the whole
     * table, and so is the referential-integrity check Postgres runs when a
     * category row is updated or deleted.
     *
     * Partial on `is_active` and carrying the sort columns for the same reason
     * as the category index: this composite *is* the customer-facing query.
     */
    index('services_category_active_order_idx')
      .on(table.categoryId, table.displayOrder, table.id)
      .where(sql`${table.isActive}`),

    /** The unfiltered listing — every active service, in display order. */
    index('services_active_order_idx')
      .on(table.displayOrder, table.id)
      .where(sql`${table.isActive}`),

    /**
     * **The pricing shape, enforced rather than agreed.** An inspection-priced
     * service with a price attached is the bug that ends with a customer shown
     * a figure nobody promised; a fixed-price service with none is a blank
     * where the price should be. Both are unrepresentable here, so neither the
     * seed script, an admin panel, nor a future import can produce one.
     *
     * `> 0` because a free service is not a pricing shape — it is a different
     * product decision, and one nobody has made.
     */
    check(
      'services_pricing_shape',
      sql`(${table.pricingKind} = 'fixed' and ${table.basePriceMinor} is not null and ${table.basePriceMinor} > 0)
          or (${table.pricingKind} = 'inspection' and ${table.basePriceMinor} is null)`,
    ),

    check(
      'services_name_has_fallback',
      sql`jsonb_typeof(${table.name}) = 'object' and jsonb_exists(${table.name}, 'az') and length(btrim(${table.name} ->> 'az')) > 0`,
    ),

    check('services_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const serviceCategoriesRelations = relations(serviceCategories, ({ many }) => ({
  services: many(services),
}));

export const servicesRelations = relations(services, ({ one }) => ({
  category: one(serviceCategories, {
    fields: [services.categoryId],
    references: [serviceCategories.id],
  }),
}));

export type ServiceRow = typeof services.$inferSelect;
export type NewServiceRow = typeof services.$inferInsert;
export type ServicePricingKindName = (typeof servicePricingKind.enumValues)[number];
