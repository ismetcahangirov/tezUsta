import type {
  EmailChangeConfirmRequest,
  EmailChangeStarted,
  EmailChangeStartRequest,
} from '@tezusta/types';

import { api } from '../api/api-slice';
import { tokenStore } from '../auth/token-store';
import { signedOut, signInEmailHinted } from '../store/session-slice';

export interface ConfirmEmailChangeArg extends EmailChangeConfirmRequest {
  /** Not sent: the server already holds it. Kept to prefill sign-in afterwards. */
  readonly newEmail: string;
}

/**
 * Changing the address the account signs in with (#514, #516, ADR-0074 § 1).
 *
 * **A confirmed change ends this session, and every other one.** The server
 * revokes them all in the same transaction that moves the address, so the
 * app does locally what a sign-out does (tokens off the device, cached data
 * dropped) without calling `/auth/logout`, whose session is already gone.
 * The new address is kept for the sign-in screen, and the route guard takes
 * the user there.
 *
 * The push device row is left alone, unlike a sign-out. The account and the
 * phone are both unchanged; the user signs straight back in on this phone,
 * and registration finds the same row again.
 */
export const emailChangeApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * Sends a code to the current address and one to the new address.
     * Calling it again replaces the pending pair, which is also how both
     * codes are sent again.
     */
    startEmailChange: build.mutation<EmailChangeStarted, EmailChangeStartRequest>({
      query: (body) => ({ url: '/me/email-change', method: 'POST', body }),
    }),

    confirmEmailChange: build.mutation<void, ConfirmEmailChangeArg>({
      query: ({ currentCode, newCode }) => ({
        url: '/me/email-change/confirm',
        method: 'POST',
        body: { currentCode, newCode },
      }),
      async onQueryStarted({ newEmail }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } catch {
          // A refused confirm leaves the session as it was; the screen
          // renders the mutation's own error.
          return;
        }
        await tokenStore.clear();
        dispatch(signedOut());
        dispatch(signInEmailHinted(newEmail));
        // Everything cached belongs to a session that no longer exists.
        dispatch(api.util.resetApiState());
      },
    }),
  }),
});

export const { useStartEmailChangeMutation, useConfirmEmailChangeMutation } = emailChangeApi;
