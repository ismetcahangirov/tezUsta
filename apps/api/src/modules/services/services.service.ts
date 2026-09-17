import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors/not-found.error';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import { PLATFORM_CURRENCY } from '../../common/money/currency';
import { CacheService } from '../../infra/cache/cache.service';
import type { CataloguePosition } from './catalogue-cursor';
import { decodeCatalogueCursor, encodeCatalogueCursor } from './catalogue-cursor';
import { ServicesRepository } from './services.repository';
import type { CatalogueListQuery, ServiceListQuery } from './services.schema';
import { MAX_CATALOGUE_PAGE_SIZE } from './services.schema';
import type {
  CursorPage,
  ServiceCategoryRecord,
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

/**
 * Every key this module writes.
 *
 * **Bump `v1` whenever `ServiceRecord` or `ServiceCategoryRecord` changes
 * shape.** During a rolling deploy two versions of this code share one Redis,
 * and the older version's payload is a perfectly well-formed envelope to the
 * newer one. The `accept` guards below are the belt; this segment is the
 * braces.
 */
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
    const records = await this.page(
      `${CATALOGUE_CACHE_PREFIX}categories`,
      decodeCatalogueCursor(query.cursor),
      query.limit,
      async (position, take) => this.repository.listActiveCategories(position, take),
      isCategoryRecordArray,
    );

    return this.paginate(records, query.limit, (record) => ({
      id: record.id,
      slug: record.slug,
      name: resolveLocalizedText(record.name, languages),
      displayOrder: record.displayOrder,
    }));
  }

  /**
   * **An unknown `categoryId` is answered without ever becoming a cache key.**
   *
   * `categoryId` is client-supplied and validated only as a UUID, so it either
   * names an existing category or names nothing — and there are 2^122 of the
   * latter. Letting one straight through into `…services:<id>` would hand an
   * anonymous caller an unbounded supply of Redis keys on the one surface in
   * the API that needs no account: every request a fresh key, a fresh database
   * read, and sixty seconds of memory in the same Redis that holds sessions
   * and rate-limit counters.
   *
   * Checking the id against the (cached, ten-row) set of active categories
   * first bounds the key space to one key per category plus one for the
   * unfiltered list. An id that names nothing gets the empty page it would
   * have got anyway, from a set lookup rather than a query.
   */
  async listServices(
    query: ServiceListQuery,
    languages: readonly string[],
  ): Promise<CursorPage<ServiceResponse>> {
    if (query.categoryId !== undefined && !(await this.activeCategoryIds()).has(query.categoryId)) {
      return { items: [], nextCursor: null };
    }

    const records = await this.page(
      `${CATALOGUE_CACHE_PREFIX}services:${query.categoryId ?? 'all'}`,
      decodeCatalogueCursor(query.cursor),
      query.limit,
      async (position, take) =>
        this.repository.listActiveServices(query.categoryId, position, take),
      isServiceRecordArray,
    );

    return this.paginate(records, query.limit, (record) =>
      this.toServiceResponse(record, languages),
    );
  }

  /**
   * One service, or a 404 — including for a service that has been deactivated,
   * or whose category has.
   *
   * **A miss is deliberately not cached.** Caching "this id does not exist"
   * would let anyone turn a public endpoint into a way to fill Redis, one
   * random UUID at a time. A hit is cheap to cache and its key space is
   * bounded by the number of services that exist; a miss is already a single
   * indexed lookup, so the asymmetry costs nothing.
   */
  async getServiceById(id: string, languages: readonly string[]): Promise<ServiceResponse> {
    const cached = await this.cache.readThrough(
      `${CATALOGUE_CACHE_PREFIX}service:${id}`,
      CATALOGUE_CACHE_TTL_SECONDS,
      async () => this.repository.findActiveServiceById(id),
      (value) => value === null || isServiceRecord(value),
    );

    if (cached === null) {
      throw new NotFoundError();
    }

    return this.toServiceResponse(cached, languages);
  }

  /** Active category ids, cached — the set `listServices` checks an id against. */
  private async activeCategoryIds(): Promise<ReadonlySet<string>> {
    const ids = await this.cache.readThrough(
      `${CATALOGUE_CACHE_PREFIX}category-ids`,
      CATALOGUE_CACHE_TTL_SECONDS,
      async () => this.repository.listActiveCategoryIds(),
      (value) => Array.isArray(value) && value.every((id) => typeof id === 'string'),
    );

    return new Set(ids);
  }

  /**
   * Reads one page: from the cache when it is the first page, from the
   * database otherwise.
   *
   * **The cached page ignores `limit`.** Two client-supplied values could
   * otherwise reach the key — the cursor and the page size — and each one
   * multiplies the key space available to an anonymous caller. So a cached
   * entry always holds a full `MAX_CATALOGUE_PAGE_SIZE` page regardless of
   * what this caller asked for, and `paginate` slices it down. A hundred and
   * one rows is a few kilobytes; a key per distinct `limit` is a hundred
   * copies of it.
   *
   * A cursored page skips the cache entirely and costs one indexed keyset
   * read, which is the query the partial indexes exist for.
   *
   * `accept` is checked against whatever comes back from Redis, so a payload
   * written by a different version of this code during a rolling deploy is
   * treated as a miss rather than cast into a shape it does not have.
   */
  private async page<T>(
    key: string,
    position: CataloguePosition | null,
    limit: number,
    load: (position: CataloguePosition | null, take: number) => Promise<T[]>,
    accept: (value: unknown) => boolean,
  ): Promise<T[]> {
    if (position !== null) {
      return load(position, limit + 1);
    }

    return this.cache.readThrough(
      key,
      CATALOGUE_CACHE_TTL_SECONDS,
      async () => load(null, MAX_CATALOGUE_PAGE_SIZE + 1),
      accept,
    );
  }

  /**
   * Turns the over-fetched rows into a page of `limit` rows plus the cursor
   * that resumes after them.
   *
   * Over-fetching is how "is there another page?" gets answered without a
   * second `COUNT(*)` over the same predicate — a count that would be a second
   * scan and could still disagree with the page it described. A cursored read
   * over-fetches by one; a cached read over-fetches to the maximum page size,
   * which answers the same question for any `limit` at or below it.
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural guards for what comes back out of Redis.
 *
 * Shape checks, not validation. The only question being asked is "did this
 * version of the code write this payload?" — the rolling-deploy case — before
 * it is cast into a record type. Re-parsing a translation map with Zod on
 * every hit would buy nothing the database CHECK does not already guarantee,
 * and would put a schema walk on the hot path this cache exists to keep cheap.
 */
function hasCommonRecordShape(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value['id'] === 'string' &&
    typeof value['slug'] === 'string' &&
    typeof value['displayOrder'] === 'number' &&
    isObject(value['name'])
  );
}

function isCategoryRecordArray(value: unknown): value is ServiceCategoryRecord[] {
  return Array.isArray(value) && value.every(hasCommonRecordShape);
}

function isServiceRecord(value: unknown): value is ServiceRecord {
  return (
    hasCommonRecordShape(value) &&
    typeof value['categoryId'] === 'string' &&
    (value['pricingKind'] === 'fixed' || value['pricingKind'] === 'inspection') &&
    (value['basePriceMinor'] === null || typeof value['basePriceMinor'] === 'number')
  );
}

function isServiceRecordArray(value: unknown): value is ServiceRecord[] {
  return Array.isArray(value) && value.every(isServiceRecord);
}
