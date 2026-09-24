import type { AdminAccount, AdminInvitationIssued } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const ME = adminMe();
const RASHAD_ID = '77777777-7777-4777-8777-777777777777';
const LEYLA_ID = '88888888-8888-4888-8888-888888888888';

const ACCOUNTS: AdminAccount[] = [
  {
    id: ME.id,
    email: ME.email,
    displayName: ME.displayName,
    status: 'active',
    roles: ['super_admin'],
    enrolled: true,
    invitationPending: false,
    createdAt: '2026-09-01T10:00:00.000Z',
  },
  {
    id: RASHAD_ID,
    email: 'rashad@tezusta.test',
    displayName: 'Rashad Aliyev',
    status: 'active',
    roles: ['support', 'finance'],
    enrolled: true,
    invitationPending: false,
    createdAt: '2026-09-02T10:00:00.000Z',
  },
  {
    id: LEYLA_ID,
    email: 'leyla@tezusta.test',
    displayName: 'Leyla Huseynova',
    status: 'disabled',
    roles: ['moderator'],
    enrolled: false,
    invitationPending: true,
    createdAt: '2026-09-03T10:00:00.000Z',
  },
];

const LINK = 'https://admin.tezusta.test/setup#k3Jx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890_-';

function issued(account: AdminAccount): AdminInvitationIssued {
  return { admin: account, setupLink: LINK, setupLinkExpiresAt: '2026-09-25T10:00:00.000Z' };
}

function adminsServer() {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: ME })
    .on('GET', '/api/admin/admins', { status: 200, body: ACCOUNTS });
}

async function openAdmins(server = adminsServer()) {
  const rendered = renderApp('/admins');
  await screen.findByRole('table', { name: 'Admins' });
  return { server, ...rendered };
}

function row(name: string): HTMLElement {
  const found = within(screen.getByRole('table', { name: 'Admins' }))
    .getAllByRole('row')
    .find((r) => r.textContent.includes(name));
  if (found === undefined) throw new Error(`No row for ${name}`);
  return found;
}

describe('admin management', () => {
  it('lists every admin with status, roles, setup state and a pending invitation', async () => {
    await openAdmins();

    expect(row('Rashad Aliyev')).toHaveTextContent('Support, Finance');
    expect(row('Rashad Aliyev')).toHaveTextContent('Active');
    expect(row('Leyla Huseynova')).toHaveTextContent('Disabled');
    expect(row('Leyla Huseynova')).toHaveTextContent('Not set up');
    expect(row('Leyla Huseynova')).toHaveTextContent('Setup link pending');
    expect(
      within(row('Leyla Huseynova')).getByRole('button', { name: 'Enable: Leyla Huseynova' }),
    ).toBeEnabled();
  });

  it("switches off every action on the signed-in admin's own row, and says why", async () => {
    await openAdmins();

    const mine = row(ME.displayName);
    expect(within(mine).getByText('You')).toBeInTheDocument();
    for (const action of ['Edit roles', 'Disable', 'Reset second factor']) {
      const button = within(mine).getByRole('button', { name: `${action}: ${ME.displayName}` });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/You cannot change your own account/);
    }
    expect(
      within(row('Rashad Aliyev')).getByRole('button', { name: 'Disable: Rashad Aliyev' }),
    ).toBeEnabled();
  });

  it('shows an invitation link once, in its dialog only, and forgets it on close', async () => {
    const newcomer: AdminAccount = {
      ...ACCOUNTS[1]!,
      id: '99999999-9999-4999-8999-999999999999',
      email: 'nigar@tezusta.test',
      displayName: 'Nigar Rzayeva',
      roles: ['moderator'],
      enrolled: false,
      invitationPending: true,
    };
    const { server, user } = await openAdmins(
      adminsServer().on('POST', '/api/admin/admins', { status: 201, body: issued(newcomer) }),
    );

    await user.click(screen.getByRole('button', { name: 'Invite admin' }));
    let dialog = screen.getByRole('dialog', { name: 'Invite an admin' });
    await user.type(within(dialog).getByLabelText('Email'), 'nigar@tezusta.test');
    await user.type(within(dialog).getByLabelText('Display name'), 'Nigar Rzayeva');
    await user.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    expect(within(dialog).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/admins')).toHaveLength(0);

    await user.click(within(dialog).getByLabelText('Moderator'));
    await user.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

    const link = await within(dialog).findByDisplayValue(LINK);
    expect(link).toHaveAttribute('readonly');
    expect(within(dialog).getByText(/Shown once/)).toHaveTextContent('out of band');
    expect(server.calls('POST', '/api/admin/admins')[0]?.body).toEqual({
      email: 'nigar@tezusta.test',
      displayName: 'Nigar Rzayeva',
      roles: ['moderator'],
    });

    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    expect(await within(dialog).findByText('Copied.')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(LINK);

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(LINK)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(LINK);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(LINK);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(LINK);
    expect(window.location.href).not.toContain(LINK);

    // Opening the dialog again starts from nothing; the link is not coming back.
    await user.click(screen.getByRole('button', { name: 'Invite admin' }));
    dialog = screen.getByRole('dialog', { name: 'Invite an admin' });
    expect(within(dialog).getByLabelText('Email')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(LINK);
  });

  it('puts a taken email on the email field', async () => {
    const { user } = await openAdmins(
      adminsServer().on('POST', '/api/admin/admins', apiError(409, 'ADMIN_EMAIL_TAKEN')),
    );

    await user.click(screen.getByRole('button', { name: 'Invite admin' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite an admin' });
    await user.type(within(dialog).getByLabelText('Email'), 'rashad@tezusta.test');
    await user.type(within(dialog).getByLabelText('Display name'), 'Rashad again');
    await user.click(within(dialog).getByLabelText('Support'));
    await user.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

    await waitFor(() => {
      expect(within(dialog).getByLabelText('Email')).toHaveAccessibleDescription(
        'An admin with this email already exists.',
      );
    });
  });

  it('disables an admin only with a reason, and explains the last-super-admin refusal', async () => {
    const path = `/api/admin/admins/${RASHAD_ID}/disable`;
    const { server, user } = await openAdmins(
      adminsServer().on('POST', path, apiError(409, 'ADMIN_LAST_SUPER_ADMIN')),
    );

    await user.click(
      within(row('Rashad Aliyev')).getByRole('button', { name: 'Disable: Rashad Aliyev' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Disable Rashad Aliyev' });
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(within(dialog).getByText('Give a reason.')).toBeInTheDocument();
    expect(server.calls('POST', path)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason'), 'Left the company');
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This would leave no active super admin. Make someone else a super admin first.',
    );
    expect(server.calls('POST', path)[0]?.body).toEqual({ reason: 'Left the company' });
  });

  it('edits roles with a reason, keeping at least one, and explains a self-action refusal', async () => {
    const path = `/api/admin/admins/${RASHAD_ID}/roles`;
    const { server, user } = await openAdmins(
      adminsServer().on('PUT', path, apiError(403, 'ADMIN_SELF_ACTION_REFUSED'), {
        status: 200,
        body: ACCOUNTS[1],
      }),
    );

    await user.click(
      within(row('Rashad Aliyev')).getByRole('button', { name: 'Edit roles: Rashad Aliyev' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Roles of Rashad Aliyev' });
    expect(within(dialog).getByLabelText('Support')).toBeChecked();
    expect(within(dialog).getByLabelText('Finance')).toBeChecked();

    await user.click(within(dialog).getByLabelText('Support'));
    await user.click(within(dialog).getByLabelText('Finance'));
    await user.type(within(dialog).getByLabelText('Reason'), 'Moved to moderation');
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(within(dialog).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(server.calls('PUT', path)).toHaveLength(0);

    await user.click(within(dialog).getByLabelText('Moderator'));
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You cannot do this to your own account. Ask another super admin.',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(server.calls('PUT', path)[1]?.body).toEqual({
      roles: ['moderator'],
      reason: 'Moved to moderation',
    });
  });

  it('resets a second factor with a reason and shows the new link once', async () => {
    const path = `/api/admin/admins/${RASHAD_ID}/reset-second-factor`;
    const { server, user } = await openAdmins(
      adminsServer().on('POST', path, { status: 200, body: issued(ACCOUNTS[1]!) }),
    );

    await user.click(
      within(row('Rashad Aliyev')).getByRole('button', {
        name: 'Reset second factor: Rashad Aliyev',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Reset second factor of Rashad Aliyev' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Lost phone');
    await user.click(within(dialog).getByRole('button', { name: 'Reset and issue link' }));

    expect(await within(dialog).findByDisplayValue(LINK)).toBeInTheDocument();
    expect(server.calls('POST', path)[0]?.body).toEqual({ reason: 'Lost phone' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(LINK);
  });
});
