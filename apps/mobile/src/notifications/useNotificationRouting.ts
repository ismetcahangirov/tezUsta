import { useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  roleSelected,
  selectAuthStatus,
  selectGrantedRoles,
  selectRole,
} from '../store/session-slice';
import {
  readNotificationTarget,
  resolveNotificationRoute,
  type NotificationTarget,
} from './notification-destination';
import { forgetLastNotificationTap, subscribeToNotificationTaps } from './push-adapter';

/**
 * Opens what a tapped notification is about.
 *
 * Mounted once, in the root layout's `AuthGate`, next to the route guard it
 * has to cooperate with.
 *
 * **The work here is waiting, not routing.** Deciding where to go is a pure
 * function (`notification-destination.ts`); what is difficult is that a tap
 * can arrive before anything is ready to act on it. On a cold start the
 * response is available before the navigator has mounted and long before the
 * refresh token has been read out of the keychain. Navigating immediately puts
 * the user on a guarded route with no session, the guard sends them to
 * sign-in, and the notification looks like it did nothing.
 *
 * So the target is **held** and released against two conditions:
 *
 * 1. **The navigator exists.** `useRootNavigationState()` is `undefined` until
 *    the root layout has mounted, and navigating before that is what produces
 *    expo-router's "attempted to navigate before mounting the Root Layout".
 * 2. **The session has settled.** `restoring` is not "signed out", it is "not
 *    known yet" — releasing then would race the very redirect this is trying
 *    to avoid.
 *
 * A `signed-out` tap needs no special case and gets none: the target simply
 * stays held while the route guard takes the user to sign-in, and the same
 * effect releases it the moment the session becomes `signed-in`. The
 * destination surviving the sign-in is a property of holding it, not a feature
 * bolted beside it.
 */
export function useNotificationRouting(): void {
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const dispatch = useAppDispatch();

  const status = useAppSelector(selectAuthStatus);
  const role = useAppSelector(selectRole);
  const grantedRoles = useAppSelector(selectGrantedRoles);

  const [pending, setPending] = useState<NotificationTarget | null>(null);

  useEffect(() => {
    const subscription = subscribeToNotificationTaps((data) => {
      const target = readNotificationTarget(data);

      // Forgotten whether or not it was readable. A payload this app cannot
      // route is still a payload it has now seen, and leaving it stored would
      // hand it to the next mount to fail on again.
      forgetLastNotificationTap();

      if (target !== null) {
        setPending(target);
      }
    });

    return (): void => {
      subscription.remove();
    };
  }, []);

  const navigatorKey = navigationState?.key;

  useEffect(() => {
    if (pending === null || navigatorKey === undefined || status !== 'signed-in') {
      return;
    }

    const destination = resolveNotificationRoute(pending, { grantedRoles, role });

    // Cleared before navigating rather than after, and cleared even when there
    // is nowhere to go. A target that stayed pending would be retried on every
    // subsequent render of this effect — including after the user had
    // navigated somewhere else themselves.
    setPending(null);

    if (destination === null) {
      return;
    }

    if (destination.role !== role) {
      // Dispatched before the navigation, so the route guard — which reads the
      // selected role — agrees with where this is going rather than correcting
      // it straight back.
      dispatch(roleSelected(destination.role));
    }

    // `replace`, never `push`: the app was not somewhere the user chose to be,
    // so there is nothing behind this worth a Back gesture.
    router.replace(destination.route);
  }, [pending, navigatorKey, status, grantedRoles, role, dispatch, router]);
}
