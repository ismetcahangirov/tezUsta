import type { ServicePricingKind } from '@tezusta/types';

import type { LocalizedText } from '../../common/i18n/localized-text.types';

/**
 * A catalogue row as the repository reads it, and as the cache stores it.
 *
 * Deliberately **not** the row type Drizzle infers, and deliberately not part
 * of `@tezusta/types`. `created_at`, `updated_at` and `is_active` are
 * operational columns and none of them is anybody's business outside this
 * module; narrowing here rather than at the response boundary means a field
 * that should never be public cannot reach the mapper to be forgotten about,
 * and cannot sit in a Redis value waiting for somebody to widen the mapper
 * later.
 *
 * `name` is still the whole locale map at this layer, because the cache is
 * shared by callers who asked for different languages — see `ServicesService`.
 * The client is sent one resolved string, which is why `ServiceCategory` in
 * the shared package has a `string` where this has a map.
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
  /**
   * The line that keeps the shared contract honest. Drizzle infers this column
   * as the database enum's members; assigning it here fails to compile the day
   * `service_pricing_kind` gains a member that `ServicePricingKind` in
   * `@tezusta/types` does not have.
   */
  readonly pricingKind: ServicePricingKind;
  readonly basePriceMinor: number | null;
  readonly displayOrder: number;
}
