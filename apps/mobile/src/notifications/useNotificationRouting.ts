import { useRootNavigationState, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { CALLING_ENABLED, usePresentIncomingCall } from '../calls';
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
import { CALL_RING_KIND } from './call-notification';
import { confirmRingingCall } from './confirm-ringing-call';
import {
  forgetLastNotificationTap,
  subscribeToForegroundNotifications,
  subscribeToNotificationTaps,
} from './push-adapter';

/** Whether a target is a ring push this build confirms with the server rather than routing. */
function isConfirmableRing(
  target: NotificationTarget,
): target is NotificationTarget & { readonly callId: string } {
  return CALLING_ENABLED && target.kind === CALL_RING_KIND && target.callId !== undefined;
}

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

  // Two slots, never one. A held tap — a cold start waiting for the session —
  // is what the person asked for, and a ring arriving in the foreground must
  // never overwrite it; nor may a tap drop a ring that is being confirmed.
  // A **tap** navigates; an **arrival** only ever opens the incoming screen,
  // and only once the server has confirmed the call (#189).
  const [pendingTap, setPendingTap] = useState<NotificationTarget | null>(null);
  const [pendingArrival, setPendingArrival] = useState<NotificationTarget | null>(null);
  const presentIncomingCall = usePresentIncomingCall();

  useEffect(() => {
    const subscription = subscribeToNotificationTaps((data) => {
      const target = readNotificationTarget(data);

      // Forgotten whether or not it was readable. A payload this app cannot
      // route is still a payload it has now seen, and leaving it stored would
      // hand it to the next mount to fail on again.
      forgetLastNotificationTap();

      if (target !== null) {
        setPendingTap(target);
      }
    });

    // Only a ring push is acted on when it merely arrives: the socket usually
    // rang already, but a phone whose socket was down would not have, and the
    // foreground handler has silenced the notification (`push-adapter.ts`).
    const arrivals = subscribeToForegroundNotifications((data) => {
      const target = readNotificationTarget(data);
      if (target !== null && isConfirmableRing(target)) {
        setPendingArrival(target);
      }
    });

    return (): void => {
      subscription.remove();
      arrivals.remove();
    };
  }, []);

  const navigatorKey = navigationState?.key;

  const ready = navigatorKey !== undefined && status === 'signed-in';

  /**
   * Confirms a ring push with the server and presents it if it is still
   * ringing this account. Otherwise `onNotRinging` — the order, for a tap;
   * nothing, for an arrival.
   */
  const confirmAndPresent = useCallback(
    (target: NotificationTarget & { readonly callId: string }, onNotRinging: () => void) => {
      void confirmRingingCall(dispatch, { callId: target.callId, orderId: target.orderId }).then(
        (call) => {
          if (call !== null) {
            presentIncomingCall(call);
          } else {
            onNotRinging();
          }
        },
      );
    },
    [dispatch, presentIncomingCall],
  );

  useEffect(() => {
    if (pendingTap === null || !ready) {
      return;
    }

    const target = pendingTap;

    // Cleared before acting rather than after, and cleared even when there
    // is nowhere to go. A target that stayed pending would be retried on every
    // subsequent render of this effect — including after the user had
    // navigated somewhere else themselves.
    setPendingTap(null);

    const openFallback = (): void => {
      const destination = resolveNotificationRoute(target, { grantedRoles, role });
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
    };

    if (isConfirmableRing(target)) {
      confirmAndPresent(target, openFallback);
      return;
    }

    openFallback();
  }, [pendingTap, ready, grantedRoles, role, dispatch, router, confirmAndPresent]);

  useEffect(() => {
    if (pendingArrival === null || !ready) {
      return;
    }
    const target = pendingArrival;
    setPendingArrival(null);
    if (isConfirmableRing(target)) {
      confirmAndPresent(target, () => undefined);
    }
  }, [pendingArrival, ready, confirmAndPresent]);
}
