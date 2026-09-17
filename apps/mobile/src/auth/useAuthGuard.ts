import { useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';

import { useAppSelector } from '../store/hooks';
import { selectAuthStatus, selectGrantedRoles, selectRole } from '../store/session-slice';

import { resolveAuthRedirect, toRouteGroup } from './route-guard';

/**
 * Keeps the user on a route their session allows, by redirecting when it does
 * not. Mounted once, in the root layout, so a deep link into any group passes
 * through it.
 *
 * The redirect is issued from an effect rather than during render: navigating
 * while the root layout is still rendering is what produces expo-router's
 * "attempted to navigate before mounting the Root Layout" warning, and the
 * effect runs after the navigator exists.
 *
 * `replace`, never `push` — a user bounced off a screen they may not see must
 * not be able to press Back into it again.
 */
export function useAuthGuard(): void {
  const router = useRouter();
  const segments = useSegments();
  const status = useAppSelector(selectAuthStatus);
  const role = useAppSelector(selectRole);
  const grantedRoles = useAppSelector(selectGrantedRoles);

  const target = resolveAuthRedirect({
    status,
    grantedRoles,
    role,
    group: toRouteGroup(segments[0]),
  });

  /**
   * The current route as a value rather than as the array expo-router hands
   * back, which is a new array on every navigation.
   *
   * **This is a dependency, not a detail** (issue #71). The effect used to be
   * keyed on the target alone, which made the guard able to correct a route
   * only when its own answer changed — so a screen that navigated *underneath*
   * it, to a different route with the same answer, was never corrected. That
   * is exactly what happened on a successful sign-in: the guard moved the user
   * to `/(customer)`, the verify screen's own redirect then moved them to
   * `/(auth)/sign-in`, the target was still `/(customer)` because both routes
   * are outside the customer group, and the effect never ran again. The user
   * was left staring at the sign-in screen holding a valid session.
   *
   * Including the path makes the guard idempotent rather than one-shot: it
   * re-asserts wherever the user actually ended up. It cannot spin, because
   * the only thing that re-runs it is the route changing, and the route it
   * navigates to is one where the target is `null`.
   */
  const path = segments.join('/');

  useEffect(() => {
    if (target === null) {
      return;
    }

    router.replace(target);
  }, [router, target, path]);
}
