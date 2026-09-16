import { Redirect } from 'expo-router';

import { AUTH_ENTRY_ROUTE, effectiveRole, ROLE_HOME_ROUTE } from '../src/auth';
import { useAppSelector } from '../src/store/hooks';
import { selectAuthStatus, selectGrantedRoles, selectRole } from '../src/store/session-slice';

/**
 * The entry route, which is now a junction and nothing else.
 *
 * It replaces the foundation smoke screen that let anyone pick a role and walk
 * into `(customer)` or `(master)` without signing in — the behaviour the route
 * guard exists to stop, so the two could not both stay.
 *
 * **What a first-run user should actually see here is an open design
 * decision** (CLAUDE.md §17: the onboarding flow is the owner's). Until it is
 * made, a user with no session goes straight to sign-in and a user with one
 * goes straight to their role's home; nothing is invented in between.
 */
export default function IndexScreen(): React.JSX.Element | null {
  const status = useAppSelector(selectAuthStatus);
  const role = useAppSelector(selectRole);
  const grantedRoles = useAppSelector(selectGrantedRoles);

  if (status === 'restoring') {
    // The splash screen is still up while the stored refresh token is being
    // traded. Rendering a spinner of our own would be a presentation decision
    // nobody has made, and rendering the sign-in screen would flash it at
    // every returning user.
    return null;
  }

  if (status === 'signed-out') {
    return <Redirect href={AUTH_ENTRY_ROUTE} />;
  }

  return <Redirect href={ROLE_HOME_ROUTE[effectiveRole(grantedRoles, role)]} />;
}
