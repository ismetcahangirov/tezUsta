import type { AdminMasterDetail, AdminMasterSummary } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const MASTER_ID = '00000000-0000-4000-8000-0000000000a1';
const DOCUMENT_ID = '00000000-0000-4000-8000-0000000000d1';

function summary(overrides: Partial<AdminMasterSummary> = {}): AdminMasterSummary {
  return {
    id: MASTER_ID,
    displayName: 'Rashad Aliyev',
    verificationStatus: 'pending_verification',
    suspendedAt: null,
    isAvailable: false,
    ratingCount: 0,
    createdAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminMasterDetail> = {}): AdminMasterDetail {
  return {
    ...summary(),
    bio: 'Plumber, twelve years in Baku.',
    documents: [
      {
        id: DOCUMENT_ID,
        documentType: 'id_card_front',
        status: 'pending_review',
        sizeBytes: 204_800,
        verifiedContentType: 'image/jpeg',
        submittedAt: '2026-09-21T10:00:00.000Z',
        reviewedAt: null,
      },
      {
        id: '00000000-0000-4000-8000-0000000000d2',
        documentType: 'selfie_with_id',
        status: 'awaiting_upload',
        sizeBytes: null,
        verifiedContentType: null,
        submittedAt: null,
        reviewedAt: null,
      },
    ],
    history: [
      {
        fromStatus: 'changes_requested',
        toStatus: 'pending_verification',
        actorKind: 'master',
        reason: null,
        createdAt: '2026-09-21T10:05:00.000Z',
      },
      {
        fromStatus: 'pending_verification',
        toStatus: 'changes_requested',
        actorKind: 'admin',
        reason: 'The ID photo is blurred.',
        createdAt: '2026-09-20T12:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const LIST = '/api/admin/masters';
const DETAIL = `/api/admin/masters/${MASTER_ID}`;

function page(items: AdminMasterSummary[], nextCursor: string | null = null) {
  return { status: 200, body: { items, nextCursor } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('master list', () => {
  it('opens on the verification queue and lists its masters', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, page([summary()]));
    renderApp('/masters');

    const table = await screen.findByRole('table', { name: 'Masters' });
    expect(within(table).getByRole('link', { name: 'Rashad Aliyev' })).toHaveAttribute(
      'href',
      `/masters/${MASTER_ID}`,
    );
    expect(within(table).getByText('Pending verification')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pending verification' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(server.calls('GET', LIST)[0]?.search.get('status')).toBe('pending_verification');
  });

  it('asks the server for the chosen status, and for every status under "All"', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, (request) =>
        page(
          request.search.get('status') === 'suspended'
            ? [summary({ displayName: 'Suspended One', verificationStatus: 'suspended' })]
            : [summary()],
        ),
      );
    const { user } = renderApp('/masters');
    await screen.findByRole('link', { name: 'Rashad Aliyev' });

    await user.click(screen.getByRole('tab', { name: 'Suspended' }));

    expect(await screen.findByRole('link', { name: 'Suspended One' })).toBeInTheDocument();
    expect(window.location.search).toBe('?status=suspended');
    expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('suspended');

    await user.click(screen.getByRole('tab', { name: 'All' }));

    await waitFor(() => expect(server.calls('GET', LIST).at(-1)?.search.has('status')).toBe(false));
  });

  it('loads the next page with the cursor the server returned', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, (request) =>
        request.search.get('cursor') === 'cursor-2'
          ? page([summary({ id: 'second', displayName: 'Second Master' })])
          : page([summary()], 'cursor-2'),
      );
    const { user } = renderApp('/masters');
    await screen.findByRole('link', { name: 'Rashad Aliyev' });

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Second Master' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rashad Aliyev' })).toBeInTheDocument();
    expect(server.calls('GET', LIST).at(-1)?.search.get('cursor')).toBe('cursor-2');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('master detail', () => {
  it('shows the profile, the documents and the verification trail', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/masters/${MASTER_ID}`);

    expect(await screen.findByRole('heading', { name: 'Rashad Aliyev' })).toBeInTheDocument();
    expect(screen.getByText('Plumber, twelve years in Baku.')).toBeInTheDocument();

    const documents = screen.getByRole('table', { name: 'Verification documents' });
    expect(within(documents).getByText('ID card, front')).toBeInTheDocument();
    expect(within(documents).getByText('image/jpeg')).toBeInTheDocument();
    expect(within(documents).getByText('Not uploaded')).toBeInTheDocument();

    expect(screen.getByText('The ID photo is blurred.')).toBeInTheDocument();
    expect(
      screen.getByText('Pending verification → Changes requested', { exact: false }),
    ).toBeInTheDocument();
  });

  it('verifies with an empty body and refreshes the master', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on(
        'GET',
        DETAIL,
        { status: 200, body: detail() },
        { status: 200, body: detail({ verificationStatus: 'active' }) },
      )
      .on('POST', `${DETAIL}/verify`, {
        status: 201,
        body: summary({ verificationStatus: 'active' }),
      });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    const dialog = screen.getByRole('dialog', { name: 'Verify this master?' });
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('The master is verified.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/verify`)[0]?.body).toEqual({});
    await waitFor(() => expect(server.calls('GET', DETAIL)).toHaveLength(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Active now: the review buttons give way to suspension.
    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });

  it.each([
    ['Reject', 'Reject this master?', 'reject', 'The master is rejected.'],
    [
      'Request more information',
      'Ask this master for more?',
      'request-more',
      'The master has been asked for more.',
    ],
    ['Suspend', 'Suspend this master?', 'suspend', 'The master is suspended.'],
  ])('%s requires a reason and sends it', async (button, dialogTitle, route, confirmation) => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/${route}`, { status: 201, body: summary() });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: button }));
    const dialog = screen.getByRole('dialog', { name: dialogTitle });
    const submit = within(dialog).getByRole('button', { name: button });

    await user.click(submit);
    expect(within(dialog).getByText('Write a reason.')).toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), '   ');
    await user.click(submit);
    expect(server.calls('POST', `${DETAIL}/${route}`)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Reason' }),
      'Documents do not match the name. ',
    );
    await user.click(submit);

    expect(await screen.findByText(confirmation)).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/${route}`)[0]?.body).toEqual({
      reason: 'Documents do not match the name.',
    });
    await waitFor(() => expect(server.calls('GET', DETAIL)).toHaveLength(2));
  });

  it('refuses a reason longer than 600 characters before sending it', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('textbox', { name: 'Reason' }));
    await user.paste('x'.repeat(601));
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));

    expect(
      within(dialog).getByText('The reason must be 600 characters or fewer.'),
    ).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/reject`)).toHaveLength(0);
  });

  it('reinstates a suspended master with an empty body', async () => {
    const suspended = detail({
      verificationStatus: 'suspended',
      suspendedAt: '2026-09-22T08:00:00.000Z',
    });
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: suspended })
      .on('POST', `${DETAIL}/reinstate`, { status: 201, body: summary() });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reinstate' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reinstate' }));

    expect(await screen.findByText('The master is reinstated.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/reinstate`)[0]?.body).toEqual({});
  });

  it('explains a conflict and refreshes when another admin acted first', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/verify`, apiError(409, 'CONFLICT'));
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Verify' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'This master’s status changed since the page loaded',
    );
    await waitFor(() => expect(server.calls('GET', DETAIL)).toHaveLength(2));
  });

  it('shows no actions to an admin who may only read masters', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', {
        status: 200,
        body: adminMe({ roles: ['support'], permissions: ['dashboard.read', 'masters.read'] }),
      })
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/masters/${MASTER_ID}`);

    await screen.findByRole('heading', { name: 'Rashad Aliyev' });
    expect(screen.queryByRole('group', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });

  it('offers review decisions but not suspension without masters.suspend', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', {
        status: 200,
        body: adminMe({ roles: ['moderator'], permissions: ['masters.read', 'masters.review'] }),
      })
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/masters/${MASTER_ID}`);

    const actions = await screen.findByRole('group', { name: 'Actions' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Verify', 'Request more information', 'Reject']);
  });

  it('opens a document through the audited download URL in a new tab', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const download = `${DETAIL}/documents/${DOCUMENT_ID}/download`;
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', download, {
        status: 200,
        body: { url: 'https://storage.test/doc?sig=1', expiresAt: '2026-09-24T10:05:00.000Z' },
      });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Open ID card, front' }));

    await waitFor(() => expect(tab.location.href).toBe('https://storage.test/doc?sig=1'));
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(server.calls('GET', download)).toHaveLength(1);

    // A second click asks again — the URL is never reused from a cache.
    await user.click(screen.getByRole('button', { name: 'Open ID card, front' }));
    await waitFor(() => expect(server.calls('GET', download)).toHaveLength(2));
  });

  it('closes the empty tab and says so when the document cannot be opened', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', `${DETAIL}/documents/${DOCUMENT_ID}/download`, apiError(404, 'NOT_FOUND'));
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Open ID card, front' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The document could not be opened. Try again.',
    );
    expect(tab.close).toHaveBeenCalled();
  });

  it('says so when the master does not exist', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, apiError(404, 'NOT_FOUND'));
    renderApp(`/masters/${MASTER_ID}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no master with this id.');
  });

  it('refuses the page to an admin without masters.read', async () => {
    installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe({ roles: ['finance'], permissions: ['dashboard.read', 'orders.read'] }),
    });
    renderApp(`/masters/${MASTER_ID}`);

    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this page' }),
    ).toBeInTheDocument();
  });
});
