import { useEffect } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';
import { readRememberedRole } from '../store/remembered-role';
import {
  roleSelected,
  selectAuthStatus,
  signedIn,
  signedOut,
  type AppRole,
} from '../store/session-slice';

import { refreshCoordinator, type RefreshCoordinator } from './refresh';

/**
 * Turns the refresh token in the keychain into a session, once, at launch.
 *
 * This is the only thing that gets a returning user past the sign-in screen:
 * the access token lives in memory and memory does not survive the app being
 * killed, so every cold start begins with no access token and a refresh token
 * that may or may not still be good.
 *
 * It runs through the same coordinator the base query uses, which matters more
 * than it looks: a query that fires during launch and 401s will join this
 * refresh rather than start a competing one, and two competing refreshes are
 * what reuse detection kills a session for (`refresh.ts`).
 *
 * A launch with no network ends in `signed-out` while the stored refresh token
 * is **kept** — the user sees the sign-in screen, which is wrong-ish, but the
 * alternative is an app that hangs on a blank screen until a timeout. A real
 * "offline, session unknown" state is a product decision nobody has made.
 *
 * A two-role user reopens in the role they last chose (`remembered-role.ts`):
 * a master who came back to the customer home would sit outside the master
 * room and miss every offer until they found the switch in Settings.
 */
export function useRestoreSession(
  coordinator: RefreshCoordinator = refreshCoordinator,
  readRole: (userId: string | null) => Promise<AppRole | null> = readRememberedRole,
): void {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectAuthStatus);

  useEffect(() => {
    if (status !== 'restoring') {
      return;
    }

    let abandoned = false;

    void (async () => {
      const outcome = await coordinator.refresh();

      if (abandoned) {
        return;
      }

      if (outcome.status === 'refreshed' && outcome.identity !== null) {
        // The role this user last chose goes in first, so `signedIn` can
        // still snap it onto a granted one if the grant has since gone.
        const remembered = await readRole(outcome.identity.userId);
        if (abandoned) {
          return;
        }
        if (remembered !== null) {
          dispatch(roleSelected(remembered));
        }
        dispatch(signedIn(outcome.identity));
        return;
      }

      dispatch(signedOut());
    })();

    return () => {
      // The dispatch is dropped, not the refresh: the new token is already in
      // the keychain either way, and cancelling the request would leave the
      // rotation half-done from the server's point of view.
      abandoned = true;
    };
  }, [coordinator, dispatch, readRole, status]);
}
