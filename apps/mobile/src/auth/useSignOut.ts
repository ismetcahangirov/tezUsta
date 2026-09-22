import { useCallback, useState } from 'react';

import { devicesApi } from '../notifications/devices-endpoints';
import { retireRegisteredDevice } from '../notifications/push-registration';
import { useAppDispatch } from '../store/hooks';
import { useSignOutEverywhereMutation, useSignOutMutation } from './auth-endpoints';

/**
 * Signing out, in the order the server requires.
 *
 * **The device row has to be retired before the session is revoked, not
 * merely before the tokens are cleared.** An access token is not checked in
 * isolation here: `apps/api/src/modules/auth/actor.service.ts` re-reads the
 * session on every request, so the moment `POST /auth/logout` lands, every
 * other request this app has in flight becomes unauthenticated — including a
 * `DELETE /devices/:id` racing alongside it. Sequencing the two is the only
 * way the retirement actually happens.
 *
 * Doing it here rather than inside the mutation's `onQueryStarted` is what
 * makes that sequencing real. `onQueryStarted` runs *after* its own request
 * has been sent, so a retirement started there would be racing the logout it
 * was meant to precede.
 *
 * **A failed retirement does not stop the sign-out.** The user has asked to
 * leave; `retireRegisteredDevice` swallows its own failure, and the server
 * has two other ways to reach the same state — a device Expo reports as
 * unreachable is retired (issue #142), and a token that turns up under another
 * account moves to it (issue #140).
 */
function useRetireThisDevice(): () => Promise<void> {
  const dispatch = useAppDispatch();

  return useCallback(
    () =>
      retireRegisteredDevice((deviceId) =>
        dispatch(devicesApi.endpoints.retireDevice.initiate(deviceId)).unwrap(),
      ),
    [dispatch],
  );
}

export interface SignOutState {
  /** True from the first step to the last, not only while the request is out. */
  readonly isSigningOut: boolean;
}

/** Sign out of this device. */
export function useSignOut(): [() => Promise<void>, SignOutState] {
  const retire = useRetireThisDevice();
  const [signOut] = useSignOutMutation();
  const [isSigningOut, setSigningOut] = useState(false);

  const run = useCallback(async () => {
    setSigningOut(true);
    try {
      await retire();
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }, [retire, signOut]);

  return [run, { isSigningOut }];
}

/**
 * Sign out of every device this user holds.
 *
 * Only *this* device is retired from the registry. The others are still
 * registered and are about to find their sessions gone; each re-registers on
 * its next launch, and until then the server simply has nobody signed in to
 * notify — `NotificationDeliveryService` resolves devices from a user, and a
 * user who is not asking for anything is not being sent anything.
 */
export function useSignOutEverywhere(): [() => Promise<void>, SignOutState] {
  const retire = useRetireThisDevice();
  const [signOutEverywhere] = useSignOutEverywhereMutation();
  const [isSigningOut, setSigningOut] = useState(false);

  const run = useCallback(async () => {
    setSigningOut(true);
    try {
      await retire();
      await signOutEverywhere();
    } finally {
      setSigningOut(false);
    }
  }, [retire, signOutEverywhere]);

  return [run, { isSigningOut }];
}
