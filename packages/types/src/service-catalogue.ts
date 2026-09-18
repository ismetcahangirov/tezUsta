/**
 * The service-catalogue wire contract — what `GET /services`,
 * `GET /services/:id` and `GET /services/categories` return, as both the API
 * and the app understand it.
 *
 * Moved here from `apps/api/src/modules/services/services.types.ts` when
 * `apps/mobile` became the second consumer (issue #33), per
 * [ADR-0016](../../../docs/decisions/ADR-0016-shared-package-timing.md). The
 * file was written to be movable: nothing in it ever referenced Drizzle, Nest
 * or Fastify, so the move is a move and not a redesign.
 *
 * The API's own row types — `ServiceRecord`, `ServiceCategoryRecord` — did
 * **not** come with it. They describe what the database holds, including a
 * whole locale map the client never sees, and they are the server's business.
 */

/**
 * Mirrors the `service_pricing_kind` Postgres enum, written out rather than
 * derived from it.
 *
 * The derivation would have to import Drizzle, and this package is imported by
 * a React Native bundle. `ServicesRepository` is where the two definitions are
 * forced to agree: it assigns the inferred column into `ServiceRecord`, so a
 * member added to the database enum and not to this union fails to compile
 * there — which is the right place for somebody to be made to think about what
 * the app renders for it.
 */
export type ServicePricingKind = 'fixed' | 'inspection';

/**
 * What the client is told about a service's price.
 *
 * A discriminated union rather than a nullable amount, so "price after
 * inspection" and "we forgot to send the price" cannot be rendered by the same
 * branch of client code. The discriminant is what lets the app's renderer be
 * exhaustive.
 *
 * **Integer minor units plus a currency code. The server never formats.**
 * `15.00 AZN` is `{ amountMinor: 1500, currency: 'AZN' }`; turning that into a
 * string is locale- and device-dependent, and a server that did it would be
 * guessing at both.
 *
 * **The app never computes with these numbers either** — it formats what it
 * was sent. A client-side price is a client-controlled price.
 */
export type ServicePricing =
  | { readonly kind: 'fixed'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'inspection' };

/**
 * `GET /services/:id/price-range` — an **indicative estimate, never a
 * quotable price** ([ADR-0013](../../../docs/decisions/ADR-0013-price-freeze-point.md)).
 * The name says so, deliberately: issue #84's acceptance criterion is that
 * the response is *labelled* indicative, not merely described that way in a
 * comment a client author might not read.
 *
 * Reuses {@link ServicePricingKind} rather than inventing a parallel
 * discriminant: `pricingKind` is the same closed set `Service.pricing.kind`
 * already carries, so a caller that already renders one renders the other.
 *
 * **A real discriminated union, not `range: X | null` on a flat interface.**
 * The flat shape used to let `{ pricingKind: 'inspection', range: {...} }`
 * typecheck — nothing tied `range`'s presence to which `pricingKind` branch
 * it was on, so a client renderer had to defensively re-check a case the
 * type system should have made unreachable. Now it cannot construct that
 * value at all: the `'inspection'` branch has no `range` field, the same way
 * {@link ServicePricing}'s `inspection` branch carries no `amountMinor`.
 *
 * The `'fixed'` branch's `range` is still `null` in one legitimate case: **no
 * eligible master currently offers this service** — a renderable "no
 * estimate yet" rather than a 404 or a made-up number.
 * `services.base_price_minor` is deliberately not substituted here: it is a
 * reference figure, not a master's authoritative price
 * ([ADR-0010](../../../docs/decisions/ADR-0010-pricing-and-commission.md)),
 * and showing it as a "range" would claim a master would actually charge it.
 *
 * `minMinor === maxMinor` is a legitimate, non-error range — a single
 * eligible master, or several who happen to charge the same amount. ADR-0013
 * explicitly permits this degenerate case.
 */
export type ServiceIndicativePriceRange =
  | {
      readonly pricingKind: 'fixed';
      readonly range: {
        readonly minMinor: number;
        readonly maxMinor: number;
        readonly currency: string;
      } | null;
    }
  | { readonly pricingKind: 'inspection' };

export interface ServiceCategory {
  readonly id: string;
  readonly slug: string;
  /** Already resolved for the caller's `Accept-Language`, with `az` as the fallback. */
  readonly name: string;
  readonly displayOrder: number;
}

export interface Service {
  readonly id: string;
  readonly categoryId: string;
  readonly slug: string;
  readonly name: string;
  readonly pricing: ServicePricing;
  readonly displayOrder: number;
}

/**
 * One page of a cursor-paginated list.
 *
 * `nextCursor` is `null` — not absent — on the last page. A client that has to
 * distinguish "no more pages" from "the field is missing because something
 * went wrong" should not have to infer it from a key that is sometimes there.
 *
 * The cursor itself is opaque: it encodes a sort position, and a client that
 * inspects or constructs one is relying on something the server is free to
 * change.
 */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
