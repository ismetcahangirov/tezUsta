import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { serviceCategories } from '../../infra/database/schema/service-categories';
import { services } from '../../infra/database/schema/services';
import type { CataloguePosition } from './catalogue-cursor';
import type { ServiceCategoryRecord, ServiceRecord } from './services.types';

/**
 * Drizzle queries for the catalogue, and nothing else — no caching, no locale
 * resolution, no HTTP (`docs/architecture/backend-architecture.md` § Module
 * rules).
 *
 * Every read here filters on `is_active`. That is not a policy this layer
 * chose: a deactivated row exists so that an order placed last month still
 * resolves, and it must never appear in anything customer-facing. Keeping the
 * predicate in the repository rather than in the service means there is no
 * query path that could accidentally omit it, and it is also what lets the
 * partial indexes (`services_active_order_idx`, `service_categories_active_
 * order_idx`) serve these reads.
 */
@Injectable()
export class ServicesRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Keyset predicate: everything ordered after `position`.
   *
   * `(display_order, id) > (o, i)` expressed as a row comparison rather than as
   * `display_order > o OR (display_order = o AND id > i)`. The two are
   * equivalent, but Postgres can match a row comparison directly against the
   * composite index, whereas the `OR` form frequently degrades into a bitmap
   * scan — the difference between an index seek and reading the pages either
   * branch could touch.
   */
  private afterPosition(
    displayOrderColumn: typeof services.displayOrder | typeof serviceCategories.displayOrder,
    idColumn: typeof services.id | typeof serviceCategories.id,
    position: CataloguePosition | null,
  ) {
    if (position === null) {
      return undefined;
    }
    return sql`(${displayOrderColumn}, ${idColumn}) > (${position.displayOrder}, ${position.id})`;
  }

  async listActiveCategories(
    position: CataloguePosition | null,
    limit: number,
  ): Promise<ServiceCategoryRecord[]> {
    return this.db
      .select({
        id: serviceCategories.id,
        slug: serviceCategories.slug,
        name: serviceCategories.name,
        displayOrder: serviceCategories.displayOrder,
      })
      .from(serviceCategories)
      .where(
        and(
          eq(serviceCategories.isActive, true),
          this.afterPosition(serviceCategories.displayOrder, serviceCategories.id, position),
        ),
      )
      .orderBy(asc(serviceCategories.displayOrder), asc(serviceCategories.id))
      .limit(limit);
  }

  /**
   * Active services **inside an active category**, optionally within one of
   * them.
   *
   * The join is not decoration. An admin who deactivates "Painting" means
   * "stop selling painting"; if the services under it stayed listed, a
   * customer could still order one and the admin would have no way to tell
   * from the panel that they could. Listing a service on its own flag alone
   * would make category deactivation a setting that hides a heading and
   * changes nothing that matters. Recorded in ADR-0020.
   *
   * The category side of the join costs a primary-key lookup against a table
   * of ten rows; the driving scan is still the partial index on `services`.
   */
  async listActiveServices(
    categoryId: string | undefined,
    position: CataloguePosition | null,
    limit: number,
  ): Promise<ServiceRecord[]> {
    return this.db
      .select({
        id: services.id,
        categoryId: services.categoryId,
        slug: services.slug,
        name: services.name,
        pricingKind: services.pricingKind,
        basePriceMinor: services.basePriceMinor,
        displayOrder: services.displayOrder,
      })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(
        and(
          eq(services.isActive, true),
          eq(serviceCategories.isActive, true),
          categoryId === undefined ? undefined : eq(services.categoryId, categoryId),
          this.afterPosition(services.displayOrder, services.id, position),
        ),
      )
      .orderBy(asc(services.displayOrder), asc(services.id))
      .limit(limit);
  }

  /**
   * The ids of every active category.
   *
   * Exists so `ServicesService` can tell an id that names a category from one
   * that names nothing, before that id becomes part of a Redis key. Without
   * that check the `categoryId` query parameter is an unbounded supply of
   * cache keys on an endpoint that needs no account — see the comment on
   * `ServicesService.listServices`.
   */
  async listActiveCategoryIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.isActive, true));

    return rows.map((row) => row.id);
  }

  /**
   * One active service, or `null`.
   *
   * A deactivated service — or one whose category has been deactivated —
   * returns `null` rather than the row, so the handler answers 404: the same
   * answer an id that never existed gets. Anything else would turn the
   * endpoint into an oracle for "this service used to exist", which is not
   * information a public endpoint owes anybody. The category condition is
   * repeated here rather than left to the listing, because a client that
   * already holds an id would otherwise keep reaching a service the admin has
   * withdrawn.
   */
  async findActiveServiceById(id: string): Promise<ServiceRecord | null> {
    const [row] = await this.db
      .select({
        id: services.id,
        categoryId: services.categoryId,
        slug: services.slug,
        name: services.name,
        pricingKind: services.pricingKind,
        basePriceMinor: services.basePriceMinor,
        displayOrder: services.displayOrder,
      })
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .where(
        and(eq(services.id, id), eq(services.isActive, true), eq(serviceCategories.isActive, true)),
      )
      .limit(1);

    return row ?? null;
  }
}
