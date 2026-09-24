import type { AdminMe } from '@tezusta/types';
import { useState } from 'react';
import { Navigate, NavLink, Outlet, useNavigate, useOutletContext } from 'react-router';

import { adminApi, useMeQuery, useSignOutMutation } from '../api/admin-api';
import { describeFailure } from '../api/api-error';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { copy } from '../copy';
import { useAppDispatch, useAppSelector } from '../hooks';
import { visibleNavigation } from './navigation';

/**
 * The authenticated frame: a fixed left navigation, a top bar with who is
 * signed in, and the content area (ADR-0043 § 8). Desktop only, on purpose —
 * the panel targets a laptop screen of 1024 px or more.
 *
 * It owns the session check: `GET /admin/me` on load, which refreshes once on
 * a 401 (see `adminBaseQuery`). A refused refresh — here or on any later
 * request — sends the admin to the sign-in page.
 */
export function Shell() {
  const signedOut = useAppSelector((state) => state.session.signedOut);
  const { data: me, error, isLoading, refetch } = useMeQuery();
  const failure = describeFailure(error);

  if (signedOut || failure?.status === 401) {
    return <Navigate to="/sign-in" replace />;
  }

  if (me === undefined) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-8">
        {isLoading || failure === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {copy.shell.loading}
          </p>
        ) : (
          <>
            <Banner tone="danger" message={copy.shell.loadFailed} />
            <Button label={copy.shell.retry} variant="secondary" onClick={() => void refetch()} />
          </>
        )}
      </main>
    );
  }

  return <ShellFrame me={me} />;
}

function ShellFrame({ me }: { me: AdminMe }) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [signOut, { isLoading: signingOut }] = useSignOutMutation();
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function handleSignOut() {
    const result = await signOut();
    if (result.error !== undefined) {
      // The cookies may still be live; saying "signed out" would be untrue.
      setSignOutFailed(true);
      return;
    }
    await navigate('/sign-in', { replace: true });
    dispatch(adminApi.util.resetApiState());
  }

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <nav
        aria-label={copy.shell.navLabel}
        className="fixed inset-y-0 left-0 flex w-nav flex-col gap-1 border-r-hairline border-border bg-surface px-3 py-6"
      >
        <p className="px-3 pb-4 text-body-strong font-bold text-text">{copy.appName}</p>
        {visibleNavigation(me.permissions).map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `rounded-full px-3 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                isActive ? 'bg-accent font-bold text-on-accent' : 'text-text hover:bg-surface-alt'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="ml-nav flex min-h-screen flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b-hairline border-border bg-surface px-8 py-3">
          {signOutFailed && (
            <p role="alert" className="text-caption text-danger">
              {copy.shell.signOutFailed}
            </p>
          )}
          <div className="flex flex-col items-end">
            <span className="text-body-strong font-bold text-text">{me.displayName}</span>
            <span className="text-caption text-text-muted">
              {me.roles.map((role) => copy.roles[role]).join(', ')}
            </span>
          </div>
          <Button
            label={copy.shell.signOut}
            loadingLabel={copy.shell.signingOut}
            loading={signingOut}
            variant="secondary"
            onClick={() => void handleSignOut()}
          />
        </header>
        <main className="flex-1 px-8 py-6">
          <Outlet context={me} />
        </main>
      </div>
    </div>
  );
}

/** The signed-in admin, for any page rendered inside the shell. */
export function useSignedInAdmin(): AdminMe {
  return useOutletContext<AdminMe>();
}
