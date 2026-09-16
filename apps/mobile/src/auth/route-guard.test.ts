import type { AppRole, AuthStatus } from '../store/session-slice';

import { effectiveRole, resolveAuthRedirect, toRouteGroup, type RouteGroup } from './route-guard';

function redirect(
  status: AuthStatus,
  grantedRoles: AppRole[],
  role: AppRole,
  group: RouteGroup | null,
): string | null {
  return resolveAuthRedirect({ status, grantedRoles, role, group });
}

describe('reading a router segment as a group', () => {
  it('recognises the four groups the app has', () => {
    expect(toRouteGroup('(auth)')).toBe('(auth)');
    expect(toRouteGroup('(customer)')).toBe('(customer)');
    expect(toRouteGroup('(master)')).toBe('(master)');
    expect(toRouteGroup('(shared)')).toBe('(shared)');
  });

  it('treats anything else as the root, so an unknown route is not an unguarded one', () => {
    expect(toRouteGroup(undefined)).toBeNull();
    expect(toRouteGroup('(admin)')).toBeNull();
    expect(toRouteGroup('orders')).toBeNull();
  });
});

describe('while the stored session is being restored', () => {
  it('leaves the user where they are', () => {
    // Redirecting here would send every returning user to the sign-in screen
    // for the length of one network round trip, then yank them off it.
    expect(redirect('restoring', [], 'customer', '(customer)')).toBeNull();
    expect(redirect('restoring', [], 'customer', null)).toBeNull();
    expect(redirect('restoring', [], 'customer', '(auth)')).toBeNull();
  });
});

describe('a signed-out user', () => {
  it('is sent to sign-in from every group', () => {
    expect(redirect('signed-out', [], 'customer', '(customer)')).toBe('/(auth)/sign-in');
    expect(redirect('signed-out', [], 'master', '(master)')).toBe('/(auth)/sign-in');
    expect(redirect('signed-out', [], 'customer', '(shared)')).toBe('/(auth)/sign-in');
    expect(redirect('signed-out', [], 'customer', null)).toBe('/(auth)/sign-in');
  });

  it('is left alone inside the auth group', () => {
    expect(redirect('signed-out', [], 'customer', '(auth)')).toBeNull();
  });
});

describe('a customer', () => {
  const roles: AppRole[] = ['customer'];

  it('stays in the customer group', () => {
    expect(redirect('signed-in', roles, 'customer', '(customer)')).toBeNull();
  });

  it('is kept out of the master group', () => {
    expect(redirect('signed-in', roles, 'customer', '(master)')).toBe('/(customer)');
  });

  it('is taken out of the auth group', () => {
    expect(redirect('signed-in', roles, 'customer', '(auth)')).toBe('/(customer)');
  });

  it('is taken off the root junction to their home', () => {
    expect(redirect('signed-in', roles, 'customer', null)).toBe('/(customer)');
  });

  it('may use the shared group', () => {
    expect(redirect('signed-in', roles, 'customer', '(shared)')).toBeNull();
  });
});

describe('a master', () => {
  const roles: AppRole[] = ['master'];

  it('stays in the master group', () => {
    expect(redirect('signed-in', roles, 'master', '(master)')).toBeNull();
  });

  it('is kept out of the customer group', () => {
    expect(redirect('signed-in', roles, 'master', '(customer)')).toBe('/(master)');
  });

  it('is sent to the master home even while the selected role says otherwise', () => {
    // The grant is what the server issued; the selection is a stale preference
    // from a previous session. Sending them to `(customer)` would bounce them
    // straight back out of it.
    expect(redirect('signed-in', roles, 'customer', '(customer)')).toBe('/(master)');
    expect(redirect('signed-in', roles, 'customer', null)).toBe('/(master)');
  });
});

describe('a user holding both roles', () => {
  const roles: AppRole[] = ['customer', 'master'];

  it('is in the customer group while the customer role is selected', () => {
    expect(redirect('signed-in', roles, 'customer', '(customer)')).toBeNull();
    expect(redirect('signed-in', roles, 'customer', '(master)')).toBe('/(customer)');
  });

  it('moves to the master group the moment the master role is selected', () => {
    // This is the whole of role switching: no re-authentication, no new token,
    // one selection and the guard follows it.
    expect(redirect('signed-in', roles, 'master', '(master)')).toBeNull();
    expect(redirect('signed-in', roles, 'master', '(customer)')).toBe('/(master)');
  });

  it('keeps the shared group available in either role', () => {
    expect(redirect('signed-in', roles, 'customer', '(shared)')).toBeNull();
    expect(redirect('signed-in', roles, 'master', '(shared)')).toBeNull();
  });
});

describe('when the token could not be read', () => {
  it('does not restrict the role groups', () => {
    // No grants means "not known", not "holds nothing". Reading it the other
    // way would bounce a legitimately signed-in user out of every group and
    // leave them nowhere to land.
    expect(redirect('signed-in', [], 'customer', '(customer)')).toBeNull();
    expect(redirect('signed-in', [], 'master', '(master)')).toBeNull();
  });

  it('still keeps the selected group and the other one apart', () => {
    expect(redirect('signed-in', [], 'customer', '(master)')).toBe('/(customer)');
  });
});

describe('the effective role', () => {
  it('is the selected one when it is granted', () => {
    expect(effectiveRole(['customer', 'master'], 'master')).toBe('master');
  });

  it('falls back to a granted role when the selection is not granted', () => {
    expect(effectiveRole(['master'], 'customer')).toBe('master');
  });

  it('stands as selected when nothing is known', () => {
    expect(effectiveRole([], 'master')).toBe('master');
  });
});
