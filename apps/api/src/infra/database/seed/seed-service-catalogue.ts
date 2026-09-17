import { inArray } from 'drizzle-orm';

import { uuidV7 } from '../../../common/ids/uuid-v7';
import type { Database } from '../database.types';
import { serviceCategories } from '../schema/service-categories';
import { services } from '../schema/services';
import { SERVICE_CATALOGUE_SEED } from './service-catalogue.seed-data';

/**
 * What one run of the seed actually changed. Returned rather than logged so a
 * test can assert idempotence — "the second run inserted nothing" is a
 * property, and a property you cannot read is a property you cannot test.
 */
export interface ServiceCatalogueSeedResult {
  readonly categoriesInserted: number;
  readonly servicesInserted: number;
}

/**
 * Loads {@link SERVICE_CATALOGUE_SEED} into `service_categories` and
 * `services`, keyed on `slug`.
 *
 * **Insert-only, never update.** `ON CONFLICT (slug) DO NOTHING` is the whole
 * conflict policy, and the alternative — upserting names, prices and ordering
 * on every run — would be actively destructive: the catalogue is admin-editable
 * (EPIC 13), so a seed that overwrote would silently revert every price an
 * admin had corrected the next time anybody ran a deploy step. The file is the
 * *initial* catalogue, not its definition.
 *
 * Consequently the result of running this twice is the result of running it
 * once, which is what makes it safe to wire into a deploy pipeline next to
 * `db:migrate`.
 *
 * Runs in one transaction: a half-seeded catalogue — categories present,
 * services missing — is a state the app would serve happily and nobody would
 * notice until a customer opened an empty category.
 */
export async function seedServiceCatalogue(db: Database): Promise<ServiceCatalogueSeedResult> {
  return db.transaction(async (tx) => {
    const categoryRows = SERVICE_CATALOGUE_SEED.map((category, displayOrder) => ({
      id: uuidV7(),
      slug: category.slug,
      name: category.name,
      displayOrder,
    }));

    const insertedCategories = await tx
      .insert(serviceCategories)
      .values(categoryRows)
      .onConflictDoNothing({ target: serviceCategories.slug })
      .returning({ slug: serviceCategories.slug });

    /**
     * Read the ids back rather than trusting the ones just generated: on a
     * re-run the insert returns nothing and the real ids are whatever the
     * first run wrote. Reading covers both cases with one query and no branch.
     */
    const persisted = await tx
      .select({ id: serviceCategories.id, slug: serviceCategories.slug })
      .from(serviceCategories)
      .where(
        inArray(
          serviceCategories.slug,
          SERVICE_CATALOGUE_SEED.map((category) => category.slug),
        ),
      );

    const idBySlug = new Map(persisted.map((row) => [row.slug, row.id]));

    /**
     * **`services.display_order` is a position in the catalogue, not a position
     * inside a category** (issue #65).
     *
     * It used to be the index within its own category, and the unfiltered
     * `GET /services` — which orders by `(display_order, id)` across the whole
     * table — therefore returned every category's first service, then every
     * category's second, and so on. Categories interleaved:
     *
     * ```
     * other-request          (Digər)
     * socket-replacement     (Elektrik)
     * drilling-and-mounting  (Kiçik tikinti və təmir)
     * ```
     *
     * A single counter that keeps running across categories fixes that with
     * nothing else changed: services come out grouped by category, categories
     * in their own `display_order`, because that is the order this loop walks
     * them in. The per-category listing is unaffected — within one category the
     * sequence is still increasing — and `(display_order, id)` is still a
     * strict total order, which is what keeps the keyset cursor unable to skip
     * or repeat a row.
     *
     * Chosen over ordering the query by `(category.display_order,
     * services.display_order, services.id)`, which was the other candidate on
     * the issue. That one needs a three-part cursor, and a three-part keyset
     * predicate over a joined column cannot be served by
     * `services_active_order_idx` — it would mean denormalising the category's
     * order onto `services` and a new index, to fix a list that reads oddly.
     * The cost here is one counter; the cost there is a schema change.
     */
    let catalogueOrder = 0;

    const serviceRows = SERVICE_CATALOGUE_SEED.flatMap((category) => {
      const categoryId = idBySlug.get(category.slug);
      if (categoryId === undefined) {
        // Unreachable: the insert above either wrote the row or found it
        // already there. Throwing rather than skipping, because the only way
        // here is a category that vanished mid-transaction, and seeding the
        // rest of the catalogue around the hole would hide that.
        throw new Error(`Seed category "${category.slug}" was neither inserted nor found.`);
      }

      return category.services.map((service) => {
        const displayOrder = catalogueOrder;
        catalogueOrder += 1;

        return {
          id: uuidV7(),
          categoryId,
          slug: service.slug,
          name: service.name,
          pricingKind: service.pricing.kind,
          basePriceMinor: service.pricing.kind === 'fixed' ? service.pricing.basePriceMinor : null,
          displayOrder,
        };
      });
    });

    const insertedServices = await tx
      .insert(services)
      .values(serviceRows)
      .onConflictDoNothing({ target: services.slug })
      .returning({ slug: services.slug });

    return {
      categoriesInserted: insertedCategories.length,
      servicesInserted: insertedServices.length,
    };
  });
}
