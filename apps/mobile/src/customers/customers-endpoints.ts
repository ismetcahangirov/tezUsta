import type { Customer } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The longest `displayName` the server accepts —
 * `MAX_DISPLAY_NAME_LENGTH` in `apps/api/src/modules/customers/customers.schema.ts`,
 * and a CHECK on the `customers` table besides.
 *
 * Transcribed rather than imported for the reason `addresses-errors.ts` gives:
 * `apps/mobile` may not import `apps/api` (CLAUDE.md §14), and a request body
 * is not a contract that crosses into `packages/types` (ADR-0016 puts only the
 * *response* shape — `Customer` — there). It is a `maxLength` on the field, not
 * a validation the client is trusted for: the server rejects a longer name
 * whatever this says.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/** What `POST /customers` takes. `.strict()` on the server: no other key. */
export interface CreateCustomerBody {
  readonly displayName: string;
}

/**
 * The caller's own customer profile (issue #94).
 *
 * **`getOwnCustomer` treats a 404 as an answer, not a failure**, and that is
 * the whole point of the endpoint. `CustomersService.getOwn` answers 404 when
 * the signed-in account has no `customers` row, which is the ordinary state of
 * every brand-new account: sign-in is phone + OTP (ADR-0008) and carries no
 * name, so nothing has created the profile yet. The query's `error` is
 * therefore read as a **state** by `customerProfileState`, which is where the
 * 404 is separated from a 500 or an offline request — the two must not look
 * alike, because one means "ask for a name" and the other means "try again".
 *
 * **`createProfile` is idempotent server-side**, by `ON CONFLICT` on
 * `customers_user_id_unique`: it answers 201 when it created the row and 200
 * when an earlier, identical call already had. So a retry after a reply that
 * never arrived is safe, and a second device is not an error — which is why
 * nothing here treats a repeat as a conflict to report. It also grants the
 * `customer` role in the same transaction.
 *
 * It **invalidates rather than writing the response into the cache**. The two
 * are equivalent on the happy path; they are not equivalent after the retry
 * above, where the 200 body is the row as it already was. Refetching means the
 * gate always renders what the server currently holds, which is the rule
 * `addresses-endpoints.ts` states for the same reason.
 */
export const customersApi = api.injectEndpoints({
  endpoints: (build) => ({
    getOwnCustomer: build.query<Customer, void>({
      query: () => '/customers/me',
      providesTags: [{ type: 'Customer', id: 'ME' }],
    }),

    createCustomerProfile: build.mutation<Customer, CreateCustomerBody>({
      query: (body) => ({ url: '/customers', method: 'POST', body }),
      invalidatesTags: (_result, error) => (error ? [] : [{ type: 'Customer', id: 'ME' }]),
    }),
  }),
});

export const { useGetOwnCustomerQuery, useCreateCustomerProfileMutation } = customersApi;
