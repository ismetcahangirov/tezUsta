import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors/not-found.error';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import { PLATFORM_CURRENCY } from '../../common/money/currency';
import { CacheService } from '../../infra/cache/cache.service';
import type { CataloguePosition } from './catalogue-cursor';
import { decodeCatalogueCursor, encodeCatalogueCursor } from './catalogue-cursor';
import { ServicesRepository } from './services.repository';
import type { CatalogueListQuery, ServiceListQuery } from './services.schema';
import type {
  CursorPage,
  ServiceCategoryResponse,
  ServicePricingResponse,
  ServiceRecord,
  ServiceResponse,
} from './services.types';

/**
 * How long a catalogue read stays cached
 * ([ADR-0020](docs/decisions/ADR-0020-public-cached-service-catalogue.md)).
 *
 * A minute, because the catalogue changes on a human timescale — an admin
 * adding a service, a price correction — and nothing in the product needs
 * either to be visible instantly. The cost of the window is that an admin's
 * edit takes up to a minute to appear; the cost of not having it is that every
 * app launch, by every user, reads the same thirty-three rows from Postgres.
 *
 * It is a TTL rather than an explicit invalidation because there is no writer
 * yet. When the admin panel lands (EPIC 13) it should call
 * `CacheService.invalidatePrefix(CATALOGUE_CACHE_PREFIX)` on a write, and this
 * window becomes the backstop rather than the mechanism.
 */
export const CATALOGUE_CACHE_TTL_SECONDS = 60;

/** Every key this module writes. Bumping `v1` invalidates the lot at once. */
export const CATALOGUE_CACHE_PREFIX = 'catalogue:v1:';

@Injectable()
export class ServicesService {
  constructor(
    private readonly repository: ServicesRepository,
    private readonly cache: CacheService,
  ) {}

  async listCategories(
    query: CatalogueListQuery,
    languages: readonly string[],
  ): Promise<CursorPage<ServiceCategoryResponse>> {
    const position = decodeCatalogueCursor(query.cursor);

    const records = await this.read(`categories:${String(query.limit)}`, position, () =>
      this.repository.listActiveCategories(position, query.limit + 1),
    );

    return this.paginate(records, query.limit, (record) => ({
      id: record.id,
      slug: record.slug,
      name: resolveLocalizedText(record.name, languages),
      displayOrder: record.displayOrder,
    }));
  }

  async listServices(
    query: ServiceListQuery,
    languages: readonly string[],
  ): Promise<CursorPage<ServiceResponse>> {
    const position = decodeCatalogueCursor(query.cursor);

    const records = await this.read(
      `services:${query.categoryId ?? 'all'}:${String(query.limit)}`,
      position,
      () => this.repository.listActiveServices(query.categoryId, position, query.limit + 1),
    );

    return this.paginate(records, query.limit, (record) =>
      this.toServiceResponse(record, languages),
    );
  }

  /**
   * One service, or a 404 — including for a service that exists but has been
   * deactivated, which the repository already declines to return.
   *
   * **A miss is deliberately not cached.** Caching "this id does not exist"
   * would let anyone turn a public endpoint into a way to fill Redis, one
   * random UUID at a time. A hit is cheap to cache and a miss is already a
   * single primary-key lookup, so the asymmetry costs nothing.
   */
  async getServiceById(id: string, languages: readonly string[]): Promise<ServiceResponse> {
    const cached = await this.cache.readThrough(
      `${CATALOGUE_CACHE_PREFIX}service:${id}`,
      CATALOGUE_CACHE_TTL_SECONDS,
      async () => this.repository.findActiveServiceById(id),
    );

    if (cached === null) {
      throw new NotFoundError();
    }

    return this.toServiceResponse(cached, languages);
  }

  /**
   * **Only the first page is cached, and that is a security decision, not an
   * omission.**
   *
   * A cache key derived from a client-supplied cursor is a key an anonymous
   * caller can mint an unlimited number of: a thousand plausible-looking
   * cursors are a thousand Redis entries and a thousand database reads, on the
   * one surface in the API that needs no account. The first page carries
   * essentially all of the traffic — the launch catalogue is thirty-three rows
   * and the default page is fifty — so caching it captures the benefit and
   * leaves nothing worth attacking.
   *
   * A deeper page still costs one indexed keyset read, which is the query the
   * partial indexes exist for.
   */
  private async read<T>(
    keySuffix: string,
    position: CataloguePosition | null,
    load: () => Promise<T[]>,
  ): Promise<T[]> {
    if (position !== null) {
      return load();
    }
    return this.cache.readThrough(
      `${CATALOGUE_CACHE_PREFIX}${keySuffix}`,
      CATALOGUE_CACHE_TTL_SECONDS,
      load,
    );
  }

  /**
   * Turns the `limit + 1` rows the repository was asked for into a page of
   * `limit` rows plus the cursor that resumes after them.
   *
   * Over-fetching by one is how "is there another page?" gets answered without
   * a second `COUNT(*)` over the same predicate — a count that would be a
   * second scan, and would still be able to disagree with the page it
   * described.
   */
  private paginate<TRecord extends { id: string; displayOrder: number }, TResponse>(
    records: readonly TRecord[],
    limit: number,
    toResponse: (record: TRecord) => TResponse,
  ): CursorPage<TResponse> {
    const page = records.slice(0, limit);
    const last = page.at(-1);
    const hasMore = records.length > limit;

    return {
      items: page.map(toResponse),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCatalogueCursor({ displayOrder: last.displayOrder, id: last.id })
          : null,
    };
  }

  private toServiceResponse(record: ServiceRecord, languages: readonly string[]): ServiceResponse {
    return {
      id: record.id,
      categoryId: record.categoryId,
      slug: record.slug,
      name: resolveLocalizedText(record.name, languages),
      pricing: toPricingResponse(record),
      displayOrder: record.displayOrder,
    };
  }
}

/**
 * The database CHECK `services_pricing_shape` guarantees a `fixed` row has a
 * price and an `inspection` row has none, so the `null` branch below is
 * unreachable through any write the application can make.
 *
 * It is still written, and it answers `inspection` rather than emitting an
 * amount of `0` or `null`. A row that somehow lost its price must render as
 * "price after inspection" — honest, and merely less specific — rather than as
 * "free", which is a promise the platform would then be on the hook for.
 */
function toPricingResponse(record: ServiceRecord): ServicePricingResponse {
  if (record.pricingKind === 'fixed' && record.basePriceMinor !== null) {
    return { kind: 'fixed', amountMinor: record.basePriceMinor, currency: PLATFORM_CURRENCY };
  }
  return { kind: 'inspection' };
}
