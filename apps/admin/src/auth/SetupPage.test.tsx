import type { AdminSetupStart } from '@tezusta/types';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiError, installFakeServer } from '../../test/fake-server';
import { renderApp } from '../../test/render-app';

const TOKEN = 'k3Jx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890_-';

const OFFER: AdminSetupStart = {
  email: 'rashad@tezusta.test',
  displayName: 'Rashad Aliyev',
  totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauthUri:
    'otpauth://totp/TezUsta%20Admin:rashad%40tezusta.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TezUsta%20Admin',
  enrolment: 'sealed-enrolment-1',
};

const GOOD_PASSWORD = 'a long enough passphrase';

async function fillForm(
  user: ReturnType<typeof renderApp>['user'],
  { password = GOOD_PASSWORD, confirm = GOOD_PASSWORD, code = '654321' } = {},
) {
  await user.type(await screen.findByLabelText('Password'), password);
  await user.type(screen.getByLabelText('Repeat password'), confirm);
  await user.type(screen.getByLabelText('Code from your authenticator'), code);
}

describe('invitation setup', () => {
  it('reads the token from the fragment, removes it from the URL, and offers the authenticator', async () => {
    const server = installFakeServer().on('POST', '/api/admin/auth/setup/start', {
      status: 200,
      body: OFFER,
    });
    renderApp(`/setup#${TOKEN}`);

    expect(await screen.findByText('Rashad Aliyev')).toBeInTheDocument();
    expect(screen.getByText('rashad@tezusta.test')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
    expect(screen.getByText(OFFER.totpSecret)).toBeInTheDocument();

    expect(server.calls('POST', '/api/admin/auth/setup/start')[0]?.body).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('blocks a submit whose passwords do not match', async () => {
    const server = installFakeServer().on('POST', '/api/admin/auth/setup/start', {
      status: 200,
      body: OFFER,
    });
    const { user } = renderApp(`/setup#${TOKEN}`);

    await fillForm(user, { confirm: 'a different passphrase' });
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/auth/setup/complete')).toHaveLength(0);
  });

  it('blocks a password shorter than twelve characters', async () => {
    const server = installFakeServer().on('POST', '/api/admin/auth/setup/start', {
      status: 200,
      body: OFFER,
    });
    const { user } = renderApp(`/setup#${TOKEN}`);

    await fillForm(user, { password: 'short', confirm: 'short' });
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(
      await screen.findByText('The password must be 12 to 128 characters.'),
    ).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/auth/setup/complete')).toHaveLength(0);
  });

  it('keeps the form and asks for a new code when the code is refused', async () => {
    const server = installFakeServer()
      .on('POST', '/api/admin/auth/setup/start', { status: 200, body: OFFER })
      .on('POST', '/api/admin/auth/setup/complete', apiError(400, 'ADMIN_TOTP_CODE_INVALID'), {
        status: 204,
      });
    const { user } = renderApp(`/setup#${TOKEN}`);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText(/That code was not accepted/)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue(GOOD_PASSWORD);
    expect(screen.getByLabelText('Code from your authenticator')).toHaveValue('');

    await user.type(screen.getByLabelText('Code from your authenticator'), '111222');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    const attempts = server.calls('POST', '/api/admin/auth/setup/complete');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body).toEqual({
      token: TOKEN,
      password: GOOD_PASSWORD,
      enrolment: OFFER.enrolment,
      code: '111222',
    });
  });

  it('goes to sign-in with a success note once setup completes', async () => {
    installFakeServer()
      .on('POST', '/api/admin/auth/setup/start', { status: 200, body: OFFER })
      .on('POST', '/api/admin/auth/setup/complete', { status: 204 });
    const { user } = renderApp(`/setup#${TOKEN}`);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(
      await screen.findByText(
        'Your account is ready. Sign in with your new password and a fresh code.',
      ),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sign-in');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('says the link is dead and to ask a super admin when the server refuses it', async () => {
    installFakeServer().on(
      'POST',
      '/api/admin/auth/setup/start',
      apiError(400, 'ADMIN_SETUP_LINK_INVALID'),
    );
    renderApp(`/setup#${TOKEN}`);

    expect(
      await screen.findByRole('heading', { name: 'This setup link does not work' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask a super admin for a new link/)).toBeInTheDocument();
  });

  it('treats a link with no token as dead without calling the server', async () => {
    const server = installFakeServer();
    renderApp('/setup');

    expect(
      await screen.findByRole('heading', { name: 'This setup link does not work' }),
    ).toBeInTheDocument();
    expect(server.requests).toHaveLength(0);
  });

  it('offers a fresh key when the offered one expired before the code arrived', async () => {
    const renewed: AdminSetupStart = { ...OFFER, enrolment: 'sealed-enrolment-2' };
    const server = installFakeServer()
      .on(
        'POST',
        '/api/admin/auth/setup/start',
        { status: 200, body: OFFER },
        { status: 200, body: renewed },
      )
      .on('POST', '/api/admin/auth/setup/complete', apiError(400, 'ADMIN_SETUP_LINK_INVALID'), {
        status: 204,
      });
    const { user } = renderApp(`/setup#${TOKEN}`);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText(/a new key was issued/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code from your authenticator'), '222333');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    const attempts = server.calls('POST', '/api/admin/auth/setup/complete');
    expect(attempts[1]?.body).toMatchObject({ enrolment: 'sealed-enrolment-2', code: '222333' });
  });
});
