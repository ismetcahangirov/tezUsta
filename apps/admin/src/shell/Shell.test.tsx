import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../test/fake-server';
import { renderApp } from '../../test/render-app';

function navigationLinks(): string[] {
  const nav = screen.getByRole('navigation', { name: 'Main navigation' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);
}

describe('authenticated shell', () => {
  it('shows every section to a super admin, with name and role in the top bar', async () => {
    installFakeServer().on('GET', '/api/admin/me', { status: 200, body: adminMe() });
    renderApp('/');

    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(navigationLinks()).toEqual([
      'Dashboard',
      'Masters',
      'Orders',
      'Disputes',
      'Catalogue',
      'Reviews',
      'Audit log',
      'Admins',
    ]);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Aysel Mammadova')).toBeInTheDocument();
    expect(within(banner).getByText('Super admin')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('hides the sections a support admin has no permission for', async () => {
    installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe({
        roles: ['support'],
        permissions: [
          'dashboard.read',
          'orders.read',
          'orders.override',
          'disputes.resolve',
          'pii.read',
          'calls.read',
          'masters.read',
        ],
      }),
    });
    renderApp('/');

    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(navigationLinks()).toEqual(['Dashboard', 'Masters', 'Orders', 'Disputes']);
    expect(within(screen.getByRole('banner')).getByText('Support')).toBeInTheDocument();
  });

  it('lists every role an admin holds', async () => {
    installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe({ roles: ['moderator', 'finance'] }),
    });
    renderApp('/');

    expect(await screen.findByText('Moderator, Finance')).toBeInTheDocument();
  });

  it('refuses a page reached by URL without the permission', async () => {
    installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe({ roles: ['finance'], permissions: ['dashboard.read', 'orders.read'] }),
    });
    renderApp('/catalogue');

    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Catalogue' })).not.toBeInTheDocument();
  });

  it('opens a permitted section from the navigation', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', '/api/admin/masters', { status: 200, body: { items: [], nextCursor: null } });
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('link', { name: 'Masters' }));

    expect(await screen.findByRole('heading', { name: 'Masters' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/masters');
  });

  it('refreshes exactly once on a 401 and retries the request', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', apiError(401, 'UNAUTHORIZED'), {
        status: 200,
        body: adminMe(),
      })
      .on('POST', '/api/admin/auth/refresh', { status: 200, body: adminMe() });
    renderApp('/');

    expect(await screen.findByText('Aysel Mammadova')).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(1);
    expect(server.calls('GET', '/api/admin/me')).toHaveLength(2);
  });

  it('lands on sign-in when the refresh is refused', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', apiError(401, 'UNAUTHORIZED'))
      .on('POST', '/api/admin/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    renderApp('/orders');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sign-in');
    expect(screen.getByText('Your session has ended. Sign in again.')).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(1);
    expect(server.calls('GET', '/api/admin/me')).toHaveLength(1);
  });

  it('signs out through the API and returns to sign-in', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/auth/sign-out', { status: 204 });
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sign-in');
    expect(server.calls('POST', '/api/admin/auth/sign-out')).toHaveLength(1);
    // A chosen sign-out is not an expired session.
    expect(screen.queryByText('Your session has ended. Sign in again.')).not.toBeInTheDocument();
  });

  it('stays put and says so when sign-out fails', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/auth/sign-out', apiError(500, 'INTERNAL_ERROR'));
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    // In the top bar: the dashboard behind it has its own (unrouted, so failing) request.
    expect(await within(screen.getByRole('banner')).findByRole('alert')).toHaveTextContent(
      'Sign-out failed. Try again.',
    );
    expect(window.location.pathname).toBe('/');
  });

  it('offers a retry when the account cannot be loaded for a reason other than the session', async () => {
    installFakeServer().on('GET', '/api/admin/me', apiError(500, 'INTERNAL_ERROR'), {
      status: 200,
      body: adminMe(),
    });
    const { user } = renderApp('/');

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('Aysel Mammadova')).toBeInTheDocument());
  });
});
