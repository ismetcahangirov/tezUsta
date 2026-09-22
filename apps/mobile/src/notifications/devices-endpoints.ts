import type { Device, DeviceRegistration } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The device registry (issue #140), as the app uses it.
 *
 * **Both endpoints are mutations nobody renders**, which is why neither
 * provides or invalidates a tag. They are dispatched imperatively — at launch,
 * when a token rotates, and at sign-out — and their results are consumed by
 * `registeredDevice`, not by a screen.
 *
 * `GET /devices` exists on the server and is deliberately absent here, for the
 * same reason `GET /auth/sessions` is absent from `auth-endpoints.ts`: its only
 * purpose is a screen listing the user's phones, and what that screen looks
 * like is an unmade design decision (CLAUDE.md §17).
 */
export const devicesApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * Register or refresh this installation.
     *
     * Idempotent on the token server-side: sending the same one twice leaves
     * one row, and sending a token that belonged to somebody else moves it to
     * the caller. That is what lets this run unconditionally at every launch.
     */
    registerDevice: build.mutation<Device, DeviceRegistration>({
      query: (body) => ({ url: '/devices', method: 'POST', body }),
    }),

    /**
     * Retire this installation — sign-out's first step.
     *
     * 404 for an id that is unknown, already retired, or somebody else's, and
     * the caller treats all three the same way: the row is not ours to worry
     * about any more.
     */
    retireDevice: build.mutation<void, string>({
      query: (id) => ({ url: `/devices/${id}`, method: 'DELETE' }),
    }),
  }),
});

export const { useRegisterDeviceMutation, useRetireDeviceMutation } = devicesApi;
