import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminCatalogue,
  AdminCatalogueCategory,
  AdminCatalogueService,
  ServicePricingKind,
} from '@tezusta/types';
import { asc, eq, inArray } from 'drizzle-orm';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { LocalizedText } from '../../common/i18n/localized-text.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { CacheService } from '../../infra/cache/cache.service';
import { isUniqueViolation } from '../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { ServiceCategoryRow } from '../../infra/database/schema/service-categories';
import { serviceCategories } from '../../infra/database/schema/service-categories';
import type { ServiceRow } from '../../infra/database/schema/services';
import { services } from '../../infra/database/schema/services';
import { CATALOGUE_CACHE_PREFIX } from './services.service';

export class CatalogueSlugTakenError extends AppError {
  constructor() {
    super(ERROR_CODES.CATALOGUE_SLUG_TAKEN, 'This slug is already used.', 409);
    this.name = 'CatalogueSlugTakenError';
    Object.setPrototypeOf(this, CatalogueSlugTakenError.prototype);
  }
}

export class CatalogueInvalidOrderError extends AppError {
  constructor() {
    super(ERROR_CODES.VALIDATION_FAILED, 'The order must list every item exactly once.', 422);
    this.name = 'CatalogueInvalidOrderError';
    Object.setPrototypeOf(this, CatalogueInvalidOrderError.prototype);
  }
}

export class CatalogueMissingPriceError extends AppError {
  constructor() {
    super(ERROR_CODES.VALIDATION_FAILED, 'A fixed-price service needs a reference price.', 422);
    this.name = 'CatalogueMissingPriceError';
    Object.setPrototypeOf(this, CatalogueMissingPriceError.prototype);
  }
}

/** Any subset of the fields, each possibly explicitly `undefined` (a validated partial body). */
export type Patch<T> = { readonly [K in keyof T]?: T[K] | undefined };

export interface CategoryInput {
  readonly slug: string;
  readonly name: LocalizedText;
  readonly displayOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

export interface ServiceInput {
  readonly categoryId: string;
  readonly slug: string;
  readonly name: LocalizedText;
  readonly pricingKind: ServicePricingKind;
  readonly basePriceMinor?: number | null | undefined;
  readonly displayOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/** What changed, for the admin audit row — only the fields that moved. */
export interface CatalogueChange<T> {
  readonly value: T;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/** Records the admin audit row inside the write's transaction. */
export type AuditRecorder = (
  tx: DatabaseExecutor,
  change: { before: Record<string, unknown>; after: Record<string, unknown>; targetId: string },
) => Promise<void>;

/**
 * Writes to the service catalogue (EPIC 13, issue #244).
 *
 * Lives beside the read path because this module owns the two tables; the
 * admin module calls it and supplies the audit writer, which runs **inside**
 * the same transaction — a catalogue edit with no audit row is an edit nobody
 * can account for.
 *
 * Nothing is ever deleted: a service that should disappear is deactivated, and
 * every order that already names it stays valid. After every committed write
 * the catalogue cache is invalidated, so the change is visible on the next
 * read rather than after the 60-second TTL (ADR-0020); the TTL stays as the
 * backstop if invalidation ever fails.
 */
@Injectable()
export class CatalogueAdminService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly cache: CacheService,
  ) {}

  async readAll(): Promise<AdminCatalogue> {
    const [categoryRows, serviceRows] = await Promise.all([
      this.db
        .select()
        .from(serviceCategories)
        .orderBy(asc(serviceCategories.displayOrder), asc(serviceCategories.id)),
      this.db.select().from(services).orderBy(asc(services.displayOrder), asc(services.id)),
    ]);
    return {
      categories: categoryRows.map((category) => ({
        ...toCategory(category),
        services: serviceRows
          .filter((service) => service.categoryId === category.id)
          .map(toService),
      })),
    };
  }

  async createCategory(
    input: CategoryInput,
    record: AuditRecorder,
  ): Promise<AdminCatalogueCategory> {
    const row = await this.write(async (tx) => {
      const [created] = await tx
        .insert(serviceCategories)
        .values({
          id: uuidV7(),
          slug: input.slug,
          name: input.name,
          displayOrder: input.displayOrder ?? (await this.nextCategoryOrder(tx)),
          isActive: input.isActive ?? true,
        })
        .returning();
      if (created === undefined) {
        throw new Error('Insert of service_categories returned no row.');
      }
      await record(tx, { targetId: created.id, before: {}, after: categoryFields(created) });
      return created;
    });
    return { ...toCategory(row), services: [] };
  }

  async updateCategory(
    id: string,
    patch: Patch<CategoryInput>,
    record: AuditRecorder,
  ): Promise<AdminCatalogueCategory> {
    const row = await this.write(async (tx) => {
      const [current] = await tx
        .select()
        .from(serviceCategories)
        .where(eq(serviceCategories.id, id))
        .for('update');
      if (current === undefined) {
        throw new NotFoundError();
      }
      const [updated] = await tx
        .update(serviceCategories)
        .set(definedOnly(patch))
        .where(eq(serviceCategories.id, id))
        .returning();
      if (updated === undefined) {
        throw new NotFoundError();
      }
      const change = diff(categoryFields(current), categoryFields(updated));
      if (Object.keys(change.after).length > 0) {
        await record(tx, { targetId: id, ...change });
      }
      return updated;
    });
    const serviceRows = await this.db
      .select()
      .from(services)
      .where(eq(services.categoryId, id))
      .orderBy(asc(services.displayOrder), asc(services.id));
    return { ...toCategory(row), services: serviceRows.map(toService) };
  }

  async createService(input: ServiceInput, record: AuditRecorder): Promise<AdminCatalogueService> {
    const row = await this.write(async (tx) => {
      await this.requireCategory(tx, input.categoryId);
      const [created] = await tx
        .insert(services)
        .values({
          id: uuidV7(),
          categoryId: input.categoryId,
          slug: input.slug,
          name: input.name,
          pricingKind: input.pricingKind,
          basePriceMinor: input.pricingKind === 'fixed' ? (input.basePriceMinor ?? null) : null,
          displayOrder: input.displayOrder ?? (await this.nextServiceOrder(tx, input.categoryId)),
          isActive: input.isActive ?? true,
        })
        .returning();
      if (created === undefined) {
        throw new Error('Insert of services returned no row.');
      }
      await record(tx, { targetId: created.id, before: {}, after: serviceFields(created) });
      return created;
    });
    return toService(row);
  }

  async updateService(
    id: string,
    patch: Patch<ServiceInput>,
    record: AuditRecorder,
  ): Promise<AdminCatalogueService> {
    const row = await this.write(async (tx) => {
      const [current] = await tx.select().from(services).where(eq(services.id, id)).for('update');
      if (current === undefined) {
        throw new NotFoundError();
      }
      if (patch.categoryId !== undefined) {
        await this.requireCategory(tx, patch.categoryId);
      }
      // The pricing shape is checked on the merged row: switching to
      // inspection clears the price; switching to fixed needs one.
      const pricingKind = patch.pricingKind ?? current.pricingKind;
      const basePriceMinor =
        pricingKind === 'inspection'
          ? null
          : patch.basePriceMinor !== undefined
            ? patch.basePriceMinor
            : current.basePriceMinor;
      if (pricingKind === 'fixed' && basePriceMinor === null) {
        throw new CatalogueMissingPriceError();
      }
      const [updated] = await tx
        .update(services)
        .set({ ...definedOnly(patch), pricingKind, basePriceMinor })
        .where(eq(services.id, id))
        .returning();
      if (updated === undefined) {
        throw new NotFoundError();
      }
      const change = diff(serviceFields(current), serviceFields(updated));
      if (Object.keys(change.after).length > 0) {
        await record(tx, { targetId: id, ...change });
      }
      return updated;
    });
    return toService(row);
  }

  /** Sets every category's display order to its position in `ids`. */
  async reorderCategories(ids: readonly string[], record: AuditRecorder): Promise<AdminCatalogue> {
    await this.write(async (tx) => {
      const rows = await tx
        .select({ id: serviceCategories.id, displayOrder: serviceCategories.displayOrder })
        .from(serviceCategories)
        .orderBy(asc(serviceCategories.displayOrder), asc(serviceCategories.id))
        .for('update');
      assertPermutation(
        rows.map((row) => row.id),
        ids,
      );
      await this.applyOrder(tx, 'category', ids);
      await record(tx, {
        targetId: ids[0] ?? '00000000-0000-0000-0000-000000000000',
        before: { order: rows.map((row) => row.id) },
        after: { order: [...ids] },
      });
    });
    return this.readAll();
  }

  /** Sets the display order of one category's services. */
  async reorderServices(
    categoryId: string,
    ids: readonly string[],
    record: AuditRecorder,
  ): Promise<AdminCatalogue> {
    await this.write(async (tx) => {
      await this.requireCategory(tx, categoryId);
      const rows = await tx
        .select({ id: services.id })
        .from(services)
        .where(eq(services.categoryId, categoryId))
        .orderBy(asc(services.displayOrder), asc(services.id))
        .for('update');
      assertPermutation(
        rows.map((row) => row.id),
        ids,
      );
      await this.applyOrder(tx, 'service', ids);
      await record(tx, {
        targetId: categoryId,
        before: { order: rows.map((row) => row.id) },
        after: { order: [...ids] },
      });
    });
    return this.readAll();
  }

  /** One transaction, a slug clash turned into 409, then the cache dropped. */
  private async write<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await this.db.transaction(work);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new CatalogueSlugTakenError();
      }
      throw error;
    }
    await this.cache.invalidatePrefix(CATALOGUE_CACHE_PREFIX);
    return result;
  }

  private async requireCategory(tx: DatabaseExecutor, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.id, id));
    if (row === undefined) {
      throw new NotFoundError();
    }
  }

  private async applyOrder(
    tx: DatabaseExecutor,
    kind: 'category' | 'service',
    ids: readonly string[],
  ): Promise<void> {
    // Spaced by ten, so a later single insert has room without renumbering.
    for (const [index, id] of ids.entries()) {
      const displayOrder = (index + 1) * 10;
      if (kind === 'category') {
        await tx
          .update(serviceCategories)
          .set({ displayOrder })
          .where(eq(serviceCategories.id, id));
      } else {
        await tx.update(services).set({ displayOrder }).where(eq(services.id, id));
      }
    }
  }

  private async nextCategoryOrder(tx: DatabaseExecutor): Promise<number> {
    const rows = await tx.select({ o: serviceCategories.displayOrder }).from(serviceCategories);
    return Math.max(0, ...rows.map((row) => row.o)) + 10;
  }

  private async nextServiceOrder(tx: DatabaseExecutor, categoryId: string): Promise<number> {
    const rows = await tx
      .select({ o: services.displayOrder })
      .from(services)
      .where(inArray(services.categoryId, [categoryId]));
    return Math.max(0, ...rows.map((row) => row.o)) + 10;
  }
}

function toCategory(row: ServiceCategoryRow): Omit<AdminCatalogueCategory, 'services'> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
  };
}

function toService(row: ServiceRow): AdminCatalogueService {
  return {
    id: row.id,
    categoryId: row.categoryId,
    slug: row.slug,
    name: row.name,
    pricingKind: row.pricingKind,
    basePriceMinor: row.basePriceMinor,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
  };
}

function categoryFields(row: ServiceCategoryRow): Record<string, unknown> {
  return { slug: row.slug, name: row.name, displayOrder: row.displayOrder, isActive: row.isActive };
}

function serviceFields(row: ServiceRow): Record<string, unknown> {
  return {
    categoryId: row.categoryId,
    slug: row.slug,
    name: row.name,
    pricingKind: row.pricingKind,
    basePriceMinor: row.basePriceMinor,
    displayOrder: row.displayOrder,
    isActive: row.isActive,
  };
}

function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function assertPermutation(current: readonly string[], proposed: readonly string[]): void {
  if (
    current.length !== proposed.length ||
    new Set(proposed).size !== proposed.length ||
    !proposed.every((id) => current.includes(id))
  ) {
    throw new CatalogueInvalidOrderError();
  }
}
