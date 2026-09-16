import { api } from '../api/api-slice';
import { otpRequested, signedIn, signedOut } from '../store/session-slice';

import { readAccessTokenIdentity } from './access-token';
import type { OtpRequest, OtpVerification, TokenPairResponse } from './auth.types';
import { tokenStore } from './token-store';

/**
 * The authentication endpoints, injected by the module that owns them rather
 * than declared on the api slice — the same reason a NestJS module owns its
 * own routes (docs/architecture/frontend-architecture.md § RTK Query
 * conventions).
 *
 * `GET /auth/sessions` exists on the server and is deliberately **not** here.
 * Its only purpose is a screen listing the user's devices, and what that
 * screen looks like is an unmade design decision (CLAUDE.md §17); an endpoint
 * with no caller is dead code that goes stale quietly.
 */
export const authApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * Sends an OTP. The response is identical for a known and an unknown
     * number, which is what stops it being a user-enumeration oracle — so the
     * screen must not draw any conclusion from it either.
     */
    requestOtp: build.mutation<void, OtpRequest>({
      query: (body) => ({ url: '/auth/otp/request', method: 'POST', body }),
      async onQueryStarted({ phone }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
          dispatch(otpRequested(phone));
        } catch {
          // The mutation's own error state is what the screen renders.
          // Rethrowing here would surface as an unhandled rejection and tell
          // nobody anything.
        }
      },
    }),

    /**
     * Verifies the code and starts the session. This is the only place a token
     * pair enters the app other than a refresh.
     */
    verifyOtp: build.mutation<TokenPairResponse, OtpVerification>({
      query: (body) => ({ url: '/auth/otp/verify', method: 'POST', body }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;

          // Stored before the session is announced. If the keychain write
          // fails the user stays signed out rather than entering a session
          // that would evaporate at the next cold start.
          await tokenStore.save(data);

          dispatch(
            signedIn(readAccessTokenIdentity(data.accessToken) ?? { userId: null, roles: [] }),
          );
        } catch {
          // Same as above: a failed verification is a rendered error, not a
          // thrown one.
        }
      },
    }),

    /**
     * Revokes this device's session.
     *
     * The local half runs **whatever the server said**. A user who taps sign
     * out on a train has asked for their tokens to be off the device;
     * refusing because the request timed out would leave a live refresh token
     * in the keychain of a phone they may be about to hand over or sell. The
     * server-side revocation is the part that can be retried later — this
     * part cannot be left undone.
     *
     * The order matters: the request goes out first, because clearing the
     * token first would send it without the bearer header the endpoint
     * requires.
     */
    signOut: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        await settle(queryFulfilled);
        await tokenStore.clear();
        dispatch(signedOut());
        dispatch(api.util.resetApiState());
      },
    }),

    /** Revokes every session the user holds, on every device. */
    signOutEverywhere: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout-all', method: 'POST' }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        await settle(queryFulfilled);
        await tokenStore.clear();
        dispatch(signedOut());
        // Every cached query result belongs to the user who just left.
        // Keeping it would show one person's orders to the next person who
        // signs in on this device.
        dispatch(api.util.resetApiState());
      },
    }),
  }),
});

/**
 * Waits for a lifecycle promise to finish and discards how it finished.
 *
 * `queryFulfilled` rejects on a failed request, and an unhandled rejection
 * inside `onQueryStarted` is reported as an unhandled promise rejection with
 * no indication of which endpoint it came from.
 */
async function settle(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The mutation's own error state is what a screen renders.
  }
}

export const {
  useRequestOtpMutation,
  useVerifyOtpMutation,
  useSignOutMutation,
  useSignOutEverywhereMutation,
} = authApi;
