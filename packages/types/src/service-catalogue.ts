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
