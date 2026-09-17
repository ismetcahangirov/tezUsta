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
   * Active services, optionally within one category.
   *
   * The category filter deliberately does **not** check that the category
   * itself is active. A service is listed on its own `is_active`, and an
   * inactive category with active services is a state an admin can produce;
   * treating it as "hide the services too" would be a second, invisible rule
   * about visibility that nothing in the schema states.
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
      .where(
        and(
          eq(services.isActive, true),
          categoryId === undefined ? undefined : eq(services.categoryId, categoryId),
          this.afterPosition(services.displayOrder, services.id, position),
        ),
      )
      .orderBy(asc(services.displayOrder), asc(services.id))
      .limit(limit);
  }

  /**
   * One active service, or `null`.
   *
   * A deactivated service returns `null` rather than the row, so the handler
   * answers 404 — the same answer an id that never existed gets. Anything else
   * would turn the endpoint into an oracle for "this service used to exist",
   * which is not information a public endpoint owes anybody.
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
      .where(and(eq(services.id, id), eq(services.isActive, true)))
      .limit(1);

    return row ?? null;
  }
}
