import type { LocalizedText } from '../../common/i18n/localized-text.types';

/**
 * Mirrors the `service_pricing_kind` Postgres enum, written out rather than
 * imported from the Drizzle schema.
 *
 * This file is the API contract, and ADR-0016 requires a contract to be
 * designed as if it were already `packages/types` — where no Drizzle type can
 * follow it. Writing the union here keeps the extraction a file move.
 *
 * The two definitions cannot drift silently: `ServicesRepository` assigns the
 * Drizzle-inferred column into `ServiceRecord`, so a member added to the
 * database enum and not to this union is a compile error at that line, which
 * is exactly where somebody should be made to think about what the client
 * renders for it.
 */
export type ServicePricingKind = 'fixed' | 'inspection';

/**
 * A catalogue row as the repository reads it, and as the cache stores it.
 *
 * Deliberately **not** the row type Drizzle infers. `created_at`, `updated_at`
 * and `is_active` are operational columns and none of them is anybody's
 * business outside this module; narrowing here rather than at the response
 * boundary means a field that should never be public cannot reach the mapper
 * to be forgotten about, and cannot sit in a Redis value waiting for somebody
 * to widen the mapper later.
 *
 * `name` is still the whole locale map at this layer, because the cache is
 * shared by callers who asked for different languages — see
 * `ServicesService`.
 */
export interface ServiceCategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: LocalizedText;
  readonly displayOrder: number;
}

export interface ServiceRecord {
  readonly id: string;
  readonly categoryId: string;
  readonly slug: string;
  readonly name: LocalizedText;
  readonly pricingKind: ServicePricingKind;
  readonly basePriceMinor: number | null;
  readonly displayOrder: number;
}

/**
 * What the client is told about a service's price.
 *
 * A discriminated union rather than a nullable amount, so
 * "price after inspection" and "we forgot to send the price" cannot be
 * rendered by the same branch of client code. The mobile app's own types
 * mirror this shape, and the discriminant is what lets its renderer be
 * exhaustive.
 *
 * **Integer minor units plus a currency code. The server never formats.**
 * `15.00 AZN` is `{ amountMinor: 1500, currency: 'AZN' }`; turning that into
 * a string is a locale-dependent, device-dependent job, and a server that did
 * it would be guessing at both.
 */
export type ServicePricingResponse =
  | { readonly kind: 'fixed'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'inspection' };

export interface ServiceCategoryResponse {
  readonly id: string;
  readonly slug: string;
  /** Resolved for this caller's `Accept-Language`, with `az` as the fallback. */
  readonly name: string;
  readonly displayOrder: number;
}

export interface ServiceResponse {
  readonly id: string;
  readonly categoryId: string;
  readonly slug: string;
  readonly name: string;
  readonly pricing: ServicePricingResponse;
  readonly displayOrder: number;
}

/**
 * One page of a cursor-paginated list.
 *
 * `nextCursor` is `null` — not absent — on the last page. A client that has to
 * distinguish "no more pages" from "the field is missing because something
 * went wrong" should not have to infer it from a key that is sometimes there.
 */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
