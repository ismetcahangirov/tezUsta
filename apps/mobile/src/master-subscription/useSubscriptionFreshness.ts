import { useEffect } from 'react';
import { AppState } from 'react-native';

import { readNotificationTarget, subscribeToForegroundNotifications } from '../notifications';
import { useAppDispatch, useAppStore } from '../store/hooks';
import { masterSubscriptionApi, refreshMySubscription } from './master-subscription-endpoints';

/** The api slice's own freshness window (`refetchOnMountOrArgChange`). */
const FRESH_FOR_MS = 30_000;

/**
 * Keeps the master's subscription from going stale while the app stays open
 * (#325, ADR-0049). The status moves on the server's clock, and a master
 * waiting on the home for offers must not read "active" after dispatch has
 * stopped sending them any.
 *
 * - **A subscription push arriving in the foreground** reads it again at once:
 *   the push is the server saying it has just changed.
 * - **Coming back from another app** reads it again only when the last read is
 *   older than the api slice's freshness window. The app does not refetch on
 *   every app switch (`api-slice.ts`), and an app switch every few seconds is
 *   not a reason to send this one request again either.
 *
 * Mounted once, at the master's layout, so a screen opened over the home does
 * not add a second listener. Invalidating a tag nothing reads fetches nothing.
 */
export function useSubscriptionFreshness(): void {
  const dispatch = useAppDispatch();
  const store = useAppStore();

  useEffect(() => {
    const arrivals = subscribeToForegroundNotifications((data) => {
      if (readNotificationTarget(data)?.kind.startsWith('subscription-') === true) {
        dispatch(refreshMySubscription());
      }
    });

    const resumes = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }
      const readAt = masterSubscriptionApi.endpoints.getMySubscription.select()(
        store.getState(),
      ).fulfilledTimeStamp;
      if (readAt === undefined || Date.now() - readAt >= FRESH_FOR_MS) {
        dispatch(refreshMySubscription());
      }
    });

    return (): void => {
      arrivals.remove();
      resumes.remove();
    };
  }, [dispatch, store]);
}
