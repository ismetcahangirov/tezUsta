import type { Address, ForwardGeocodeResult } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The request bodies these endpoints send, hand-written rather than imported.
 *
 * `apps/api/src/modules/addresses/addresses.schema.ts` defines the server's
 * Zod validation for the same shapes, but a request body is not a contract
 * that crosses into `packages/types` (ADR-0016 puts only the *response* shape
 * — `Address` — there) and `apps/mobile` may not import `apps/api`
 * (CLAUDE.md §14). Written to match the server's field names and optionality
 * exactly, the same discipline `CatalogueQueryArg` follows in
 * `service-catalogue-endpoints.ts`.
 */
export interface AddressDetailFields {
  readonly label?: string;
  readonly building?: string;
  readonly entrance?: string;
  readonly floor?: string;
  readonly apartment?: string;
  readonly landmarkNote?: string;
}

export interface CreateAddressBody extends AddressDetailFields {
  readonly formattedAddress: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly isDefault?: boolean;
}

/**
 * Every field optional and the nullable ones accepting `null` to clear them —
 * `updateAddressSchema`'s own shape. `isDefault` never carries `false` from
 * this app: the server treats "stop being the default" as a distinct,
 * refused operation (`DefaultAddressRequiredError`, 409), and the only
 * default-related action this screen offers is promoting a different address.
 */
export interface UpdateAddressFields {
  readonly label?: string | null;
  readonly formattedAddress?: string;
  readonly building?: string | null;
  readonly entrance?: string | null;
  readonly floor?: string | null;
  readonly apartment?: string | null;
  readonly landmarkNote?: string | null;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly isDefault?: true;
}

export interface UpdateAddressArg {
  readonly id: string;
  readonly patch: UpdateAddressFields;
}

/**
 * The customer's saved addresses, injected into the one API slice by the
 * feature that owns them (`docs/architecture/frontend-architecture.md` § RTK
 * Query conventions).
 *
 * **One tag, `{ type: 'Address', id: 'LIST' }`, covers the whole set.** There
 * is no per-address detail query in this screen — the list is the only read —
 * so a row-level tag would add bookkeeping with nothing to invalidate it
 * separately from the list itself.
 *
 * **Mutations invalidate; nothing here patches the cache optimistically.**
 * `master-availability-endpoints.ts` patches because the mutation's own
 * response is the complete state to show. Deleting or promoting a default
 * address is different: the server decides *which other address* becomes the
 * default, and guessing that client-side is exactly what issue #90 rules out
 * ("render what came back; never guess locally"). Invalidating and letting
 * `listAddresses` refetch is what guarantees the screen renders the server's
 * own answer rather than a client's prediction of it.
 *
 * `update` and `delete` invalidate on failure too, not only on success: a 404
 * there means the address the row pointed at is already gone — not the
 * caller's, or removed by another device — and the fix is the same either
 * way, a refetch that drops the stale row rather than a client-side guess
 * about which id to remove.
 */
export const addressesApi = api.injectEndpoints({
  endpoints: (build) => ({
    listAddresses: build.query<Address[], void>({
      query: () => '/addresses',
      providesTags: [{ type: 'Address', id: 'LIST' }],
    }),

    createAddress: build.mutation<Address, CreateAddressBody>({
      query: (body) => ({ url: '/addresses', method: 'POST', body }),
      invalidatesTags: (_result, error) => (error ? [] : [{ type: 'Address', id: 'LIST' }]),
    }),

    updateAddress: build.mutation<Address, UpdateAddressArg>({
      query: ({ id, patch }) => ({ url: `/addresses/${id}`, method: 'PATCH', body: patch }),
      invalidatesTags: [{ type: 'Address', id: 'LIST' }],
    }),

    deleteAddress: build.mutation<void, string>({
      query: (id) => ({ url: `/addresses/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Address', id: 'LIST' }],
    }),

    /**
     * Forward geocoding for the add/edit form's "find address" step. A
     * `mutation` rather than a `query`: there is nothing to cache under a
     * stable argument — every call is a customer typing a new draft address —
     * and the same reasoning already governs `setAvailability` and
     * `sendHeartbeat` in `master-availability-endpoints.ts`, on-demand POSTs
     * with no cache entry of their own.
     *
     * Every outcome, including "the provider is unavailable", is a 200 the
     * caller switches on (`ForwardGeocodeResult`) — see
     * `packages/types/src/geocoding.ts`. Nothing here retries on `no-result`
     * or `unavailable`; retrying is the customer pressing the button again,
     * with their typed text still in the field.
     */
    forwardGeocode: build.mutation<ForwardGeocodeResult, string>({
      query: (address) => ({ url: '/geocode/forward', method: 'POST', body: { address } }),
    }),
  }),
});

export const {
  useListAddressesQuery,
  useCreateAddressMutation,
  useUpdateAddressMutation,
  useDeleteAddressMutation,
  useForwardGeocodeMutation,
} = addressesApi;
