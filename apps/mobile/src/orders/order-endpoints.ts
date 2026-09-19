import type {
  Order,
  OrderPhoto,
  OrderPhotoUpload,
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
  useServiceIndicativePriceRangeQuery,
  usePresignOrderPhotoMutation,
  useConfirmOrderPhotoMutation,
  useAttachOrderPhotoMutation,
} = ordersApi;
