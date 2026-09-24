import type {
  CursorPage,
  Order,
  OrderDetail,
  OrderPhoto,
  OrderPhotoDownload,
  OrderPhotoUpload,
  OrderSummary,
  ServiceIndicativePriceRange,
} from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The request bodies these endpoints send, hand-written rather than imported.
 *
 * `apps/api/src/modules/orders/orders.schema.ts` defines the server's Zod
 * validation for the same shapes, but a request body is not a contract that
 * crosses into `packages/types` (ADR-0016 puts only the *response* shape —
 * `Order` — there) and `apps/mobile` may not import `apps/api` (CLAUDE.md
 * §14). Written to match the server's field names exactly, the same discipline
 * `addresses-endpoints.ts` follows.
 *
 * **There is no price field, and there never will be.** The customer never
 * submits an amount, at creation or anywhere else
 * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md),
 * [ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)); the server would
 * reject one outright, because `createOrderSchema` is `.strict()`.
 */
export interface CreateOrderBody {
  readonly serviceId: string;
  readonly addressId: string;
  readonly description: string;
  /**
   * The client's own key for "this is the same request I already sent".
   *
   * Generated once per **attempt** — one customer pressing the button once —
   * and reused across every retry of that attempt. Regenerating it per request
   * would defeat the entire mechanism: the server would see two different
   * keys, and a flaky connection would leave the customer with two masters on
   * their way to the same tap.
   */
  readonly idempotencyKey: string;
}

export interface AttachOrderPhotoArg {
  readonly orderId: string;
  readonly photoId: string;
}

/** One photo of one order — both ids, because the download route checks both. */
export interface OrderPhotoDownloadArg {
  readonly orderId: string;
  readonly photoId: string;
}

/**
 * Orders, injected into the one API slice by the feature that owns them.
 *
 * **No mutation here patches the cache optimistically.** An order's status is
 * the server's answer, not a prediction: creation lands it in `SEARCHING`
 * through a transition the state machine owns (ADR-0015), and an app that
 * wrote `SEARCHING` locally would be asserting something it cannot know.
 *
 * `createOrder` deliberately does **not** invalidate anything on failure. A
 * failed creation changed nothing on the server — unless it did, and the
 * response was lost, in which case the retry carries the same idempotency key
 * and returns the very same order.
 */
export const ordersApi = api.injectEndpoints({
  endpoints: (build) => ({
    createOrder: build.mutation<Order, CreateOrderBody>({
      query: (body) => ({ url: '/orders', method: 'POST', body }),
      invalidatesTags: (_result, error) => (error ? [] : [{ type: 'Order', id: 'LIST' }]),
    }),

    /**
     * One order by id — what the order screen reads (issue #155).
     *
     * **The id is the only input.** Nothing about the order is passed through
     * navigation: a status carried in a route parameter is a status that was
     * true when the navigation started, and this is the screen whose entire
     * subject is what has changed since then
     * ([ADR-0029](docs/decisions/ADR-0029-customer-order-screen.md)).
     *
     * Tagged per id so a later transition can invalidate exactly this order
     * rather than every order in the cache. `createOrder` already invalidates
     * `{ id: 'LIST' }`, which this entry deliberately does not answer to — a new
     * order is not a change to an existing one.
     *
     * **A 404 is the API's answer for somebody else's order**, never a 403
     * (`apps/api/src/modules/orders/orders.controller.ts`), so nothing here
     * treats "not found" and "not yours" as different outcomes. The screen
     * renders one plain message for both, which is the whole point of the API
     * answering that way.
     *
     * An `OrderDetail`: the order plus the customer's unread message count,
     * which the conversation entry on the order screen badges (issue #182),
     * and the assigned master's rating for the status card (issue #228).
     */
    order: build.query<OrderDetail, string>({
      query: (orderId) => `/orders/${orderId}`,
      providesTags: (_result, _error, orderId) => [{ type: 'Order', id: orderId }],
    }),

    /**
     * The customer's own orders, newest first (issue #160,
     * [ADR-0030](docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
     *
     * **An infinite query rather than one cache entry with `merge`.** The two
     * look interchangeable until something invalidates the list — and something
     * does: `createOrder` invalidates `{ type: 'Order', id: 'LIST' }`, which is
     * this entry. A merged single entry answers that by refetching its *most
     * recent argument* — the last cursor — and merging the result back into
     * pages it never re-read, so a row that has since shifted a page down is
     * now on screen twice. `infiniteQuery` refetches the pages it holds.
     *
     * **The cursor is the server's, opaque, and never built here.** It encodes
     * `(createdAt, id)` (`apps/api/src/modules/orders/order-cursor.ts`) and
     * keyset pagination is what makes "a customer creating an order while
     * paging must not see a row twice" true at all — an offset would renumber
     * every row behind the one just inserted.
     *
     * `initialPageParam` is `null` rather than `undefined`: RTK Query reads
     * `undefined` from `getNextPageParam` as "there are no more pages", so a
     * page param that could *be* `undefined` would make the first page and the
     * last page indistinguishable.
     *
     * No `status` filter is sent. "Open" is nine of the fourteen statuses and
     * `?status=` takes one, so the split between open and finished orders is
     * made on the client, over the pages already loaded (ADR-0030 § 3).
     */
    customerOrders: build.infiniteQuery<CursorPage<OrderSummary>, void, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
      query: ({ pageParam }) => ({
        url: '/orders',
        ...(pageParam === null ? {} : { params: { cursor: pageParam } }),
      }),
      providesTags: [{ type: 'Order', id: 'LIST' }],
    }),

    /**
     * The photos attached to one order (issue #83).
     *
     * A separate request from the order itself because it is a separate
     * endpoint, and a separate cache entry because a photo attached after the
     * order was read should not force the order to be re-fetched to appear.
     * Visible to the order's customer and its assigned master; anybody else
     * gets the same 404 the order does.
     */
    orderPhotos: build.query<readonly OrderPhoto[], string>({
      query: (orderId) => `/orders/${orderId}/photos`,
      providesTags: (_result, _error, orderId) => [{ type: 'Order', id: `${orderId}/photos` }],
    }),

    /**
     * A short-lived read URL for one photo.
     *
     * **A request per thumbnail, and that is the design rather than an
     * oversight.** `OrderPhoto` carries no URL: a presigned link is a capability
     * with an expiry, and embedding one in a list response would put it in a
     * cache that outlives it
     * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)). Each thumbnail
     * therefore asks for its own, and asks again when it expires.
     *
     * `keepUnusedDataFor: 0` for the same reason the indicative price range
     * uses it: what is cached here stops working after a few minutes, and a
     * cached dead URL renders as a broken image rather than as a retry.
     */
    orderPhotoDownload: build.query<OrderPhotoDownload, OrderPhotoDownloadArg>({
      query: ({ orderId, photoId }) => `/orders/${orderId}/photos/${photoId}/download`,
      keepUnusedDataFor: 0,
    }),

    /**
     * The indicative range for a service (issue #84).
     *
     * An estimate, never a quotable price — the real price is frozen at accept,
     * from the accepting master (ADR-0013), so this is shown before the
     * commitment point and never presented as what the customer will pay.
     *
     * `keepUnusedDataFor: 0` because the server refuses to cache it for the
     * same reason: masters change their prices, and a stale range shown next to
     * the word "estimate" is still a number a customer anchors on.
     */
    serviceIndicativePriceRange: build.query<ServiceIndicativePriceRange, string>({
      query: (serviceId) => `/services/${serviceId}/price-range`,
      keepUnusedDataFor: 0,
    }),

    /**
     * Step one of a photo upload: the server mints a short-lived URL and a key
     * of its own choosing.
     *
     * The bytes never pass through the API ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)),
     * which is why this returns a URL rather than accepting a file. The client
     * never sees, chooses, or sends a storage key.
     */
    presignOrderPhoto: build.mutation<OrderPhotoUpload, string>({
      query: (contentType) => ({
        url: '/orders/photos/presign',
        method: 'POST',
        body: { contentType },
      }),
    }),

    /**
     * Step three, after the client has PUT the bytes straight to storage.
     *
     * The server validates the **real object** here — its size against
     * `head()`, its leading bytes against an allow-list — because a declared
     * content type is a client assertion and a declared length is a claim
     * ([ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)).
     */
    confirmOrderPhoto: build.mutation<OrderPhoto, string>({
      query: (photoId) => ({ url: `/orders/photos/${photoId}/confirm`, method: 'POST' }),
    }),

    /** Step four: bind a confirmed photo to an order that is still accepting them. */
    attachOrderPhoto: build.mutation<OrderPhoto, AttachOrderPhotoArg>({
      query: ({ orderId, photoId }) => ({
        url: `/orders/${orderId}/photos`,
        method: 'POST',
        body: { photoId },
      }),
    }),
  }),
});

export const {
  useCreateOrderMutation,
  useCustomerOrdersInfiniteQuery,
  useOrderQuery,
  useOrderPhotosQuery,
  useOrderPhotoDownloadQuery,
  useServiceIndicativePriceRangeQuery,
  usePresignOrderPhotoMutation,
  useConfirmOrderPhotoMutation,
  useAttachOrderPhotoMutation,
} = ordersApi;
