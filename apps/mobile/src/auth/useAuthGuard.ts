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

  useEffect(() => {
    if (target === null) {
      return;
    }

    router.replace(target);
  }, [router, target]);
}
