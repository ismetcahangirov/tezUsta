import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../test/fake-server';
import { renderApp } from '../../test/render-app';

const NEW_PASSWORD = 'a brand new passphrase';

async function openDialog(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Change password' }));
  return screen.getByRole('dialog', { name: 'Change your password' });
}

// Each value is pasted into a focused field, as a password manager fills one.
// Typing them key by key, and clicking each field, cost these tests close to
// two seconds of their five; the request and its answer are their subject,
// not the keyboard (#385).
async function enter(
  user: ReturnType<typeof renderApp>['user'],
  dialog: HTMLElement,
  label: string,
  value: string,
) {
  act(() => {
    within(dialog).getByLabelText(label).focus();
  });
  await user.paste(value);
}

describe('changing your own password (#329)', () => {
  it('sends the current password, the new one and a code, and confirms', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/me/password', { status: 204 });
    const { user } = renderApp('/');
    const dialog = await openDialog(user);

    await enter(user, dialog, 'Current password', 'the old passphrase');
    await enter(user, dialog, 'New password', NEW_PASSWORD);
    await enter(user, dialog, 'Repeat new password', NEW_PASSWORD);
    await enter(user, dialog, 'Code from your authenticator', '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(await within(dialog).findByText(/Your password is changed/)).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/me/password')[0]?.body).toEqual({
      currentPassword: 'the old passphrase',
      newPassword: NEW_PASSWORD,
      code: '123456',
    });
  });

  it('checks the form before sending anything', async () => {
    const server = installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe(),
    });
    const { user } = renderApp('/');
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('New password'), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(within(dialog).getByText('Enter your current password.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('The password must be 12 to 128 characters.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the 6-digit code.')).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/me/password')).toHaveLength(0);
  });

  it('says the password or the code was refused, and clears the code', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('POST', '/api/admin/me/password', apiError(400, 'ADMIN_CREDENTIALS_INVALID'));
    const { user } = renderApp('/');
    const dialog = await openDialog(user);

    await enter(user, dialog, 'Current password', 'a wrong passphrase');
    await enter(user, dialog, 'New password', NEW_PASSWORD);
    await enter(user, dialog, 'Repeat new password', NEW_PASSWORD);
    await enter(user, dialog, 'Code from your authenticator', '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The current password or the code was not accepted.',
    );
    expect(within(dialog).getByLabelText('Code from your authenticator')).toHaveValue('');
  });
});
