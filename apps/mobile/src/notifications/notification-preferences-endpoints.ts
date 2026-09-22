import type { NotificationPreference, NotificationPreferencesUpdate } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * Notification preferences (issue #143 on the server, #147 here).
 *
 * **The server owns the vocabulary.** The read returns every category — not
 * only the ones this user has stored a row for — so the screen renders what it
 * is given and never has to know what a missing row means. Nothing in the app
 * enumerates categories.
 */
export const notificationPreferencesApi = api.injectEndpoints({
  endpoints: (build) => ({
    getNotificationPreferences: build.query<NotificationPreference[], void>({
      query: () => '/notification-preferences',
    }),

    /**
     * Replaces the whole set.
     *
     * **`PUT`, and the body is the state.** A category the body does not name
     * returns to its default, which is what makes a retry on a flaky mobile
     * network land the same result as the first attempt.
     *
     * The write is optimistic and the rollback is the part that matters. These
     * are small, frequent taps and waiting out a round trip for each one reads
     * as a broken control — but a toggle that springs back with no explanation
     * is worse than one that refused in the first place, so the failure is left
     * for the screen to render (`mutation.isError`) rather than swallowed here.
     */
    setNotificationPreferences: build.mutation<
      NotificationPreference[],
      NotificationPreferencesUpdate
    >({
      query: (body) => ({ url: '/notification-preferences', method: 'PUT', body }),
      async onQueryStarted(update, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          notificationPreferencesApi.util.updateQueryData(
            'getNotificationPreferences',
            undefined,
            // Returns a new array rather than mutating the draft: a
            // `NotificationPreference` is readonly all the way down, which is
            // the contract saying a client does not edit the server's answer
            // in place.
            (draft) =>
              draft.map((entry) => {
                const requested = update.preferences.find(
                  (candidate) => candidate.category === entry.category,
                );

                // `changeable` is the server's rule and this respects it
                // rather than re-deciding it: an optimistic patch that
                // switched off a locked category would show the user a state
                // the server is about to refuse.
                if (requested === undefined || !entry.changeable) {
                  return entry;
                }

                return { ...entry, enabled: requested.enabled };
              }),
          ),
        );

        try {
          const { data } = await queryFulfilled;

          // Replaced with the server's own answer rather than left on the
          // optimistic guess. The two agree in the normal case; when they do
          // not, the server is right.
          dispatch(
            notificationPreferencesApi.util.updateQueryData(
              'getNotificationPreferences',
              undefined,
              () => data,
            ),
          );
        } catch {
          // The documented rollback. Without it the cache keeps a value the
          // server never accepted, and the screen goes on showing it until
          // something else refetches.
          patch.undo();
        }
      },
    }),
  }),
});

export const { useGetNotificationPreferencesQuery, useSetNotificationPreferencesMutation } =
  notificationPreferencesApi;
