import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../test/fake-server';
import { renderApp } from '../../test/render-app';

async function fillSignIn(
  user: ReturnType<typeof renderApp>['user'],
  { email = 'aysel@tezusta.test', password = 'correct horse battery', code = '123456' } = {},
) {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.type(screen.getByLabelText('Authenticator code'), code);
}

describe('sign-in', () => {
  it('signs in with all three factors in one request and lands in the shell', async () => {
    const server = installFakeServer().on('POST', '/api/admin/auth/sign-in', {
      status: 200,
      body: adminMe(),
    });
    const { user } = renderApp('/sign-in');

    await fillSignIn(user, { email: '  aysel@tezusta.test ' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByText('Aysel Mammadova')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(server.calls('POST', '/api/admin/auth/sign-in')[0]?.body).toEqual({
      email: 'aysel@tezusta.test',
      password: 'correct horse battery',
      code: '123456',
    });
    // The answer to sign-in is the admin; the shell does not ask again.
    expect(server.calls('GET', '/api/admin/me')).toHaveLength(0);
  });

  it('shows one generic message on a 401, whichever factor was wrong', async () => {
    installFakeServer().on('POST', '/api/admin/auth/sign-in', apiError(401, 'UNAUTHORIZED'));
    const { user } = renderApp('/sign-in');

    await fillSignIn(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in failed. Check your email, password and code.',
    );
    expect(window.location.pathname).toBe('/sign-in');
    // A rejected code is cleared so the next attempt starts from a fresh one.
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('');
  });

  it('does not refresh after a sign-in 401 — the answer is the answer', async () => {
    const server = installFakeServer().on(
      'POST',
      '/api/admin/auth/sign-in',
      apiError(401, 'UNAUTHORIZED'),
    );
    const { user } = renderApp('/sign-in');

    await fillSignIn(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');

    expect(server.calls('POST', '/api/admin/auth/refresh')).toHaveLength(0);
  });

  it('says so when the attempts are rate limited', async () => {
    installFakeServer().on('POST', '/api/admin/auth/sign-in', apiError(429, 'RATE_LIMITED'));
    const { user } = renderApp('/sign-in');

    await fillSignIn(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait a few minutes and try again.',
    );
  });

  it('asks for six digits before sending anything', async () => {
    const server = installFakeServer();
    const { user } = renderApp('/sign-in');

    await fillSignIn(user, { code: '12a34' });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter the 6-digit code.')).toBeInTheDocument();
    expect(server.requests).toHaveLength(0);
  });

  it('disables the button while the request is in flight', async () => {
    let answer: (value: { status: number; body: unknown }) => void = () => undefined;
    installFakeServer().on(
      'POST',
      '/api/admin/auth/sign-in',
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { user } = renderApp('/sign-in');

    await fillSignIn(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
    answer({ status: 200, body: adminMe() });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });
});
