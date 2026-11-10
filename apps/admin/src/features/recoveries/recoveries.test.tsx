import type {
  AdminAccountRecovery,
  AdminCustomerDetail,
  AdminMasterDetail,
  AdminOrderSummary,
  AdminPermission,
  AdminRole,
} from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';
import { recoveriesCopy, recoveryErrorMessage } from './copy';

/**
 * Account recovery in the panel (#517, ADR-0074 §§ 2–3), through the real
 * store, router and base query. Only `fetch` is fake, so what is asserted is
 * what the admin sees and what the API is sent.
 */

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER_ADMIN = '00000000-0000-4000-8000-000000000002';
const RECOVERY_ID = '0b9e7d1c-0000-4000-8000-0000000000f1';
const CUSTOMER_ID = '0b9e7d1c-0000-4000-8000-000000000001';
const MASTER_ID = '00000000-0000-4000-8000-0000000000a1';

const LIST = '/api/admin/account-recoveries';
const DETAIL = `${LIST}/${RECOVERY_ID}`;
const CUSTOMER = `/api/admin/customers/${CUSTOMER_ID}`;
const MASTER = `/api/admin/masters/${MASTER_ID}`;

/** "Now" for every test; the hold below ends three days later. */
const NOW = new Date('2026-11-11T10:00:00.000Z');
const HOLD_UNTIL = '2026-11-14T10:00:00.000Z';

const SUPPORT: readonly AdminPermission[] = [
  'dashboard.read',
  'customers.read',
  'masters.read',
  'subscriptions.read',
  'pii.read',
  'accounts.recover',
];

function me(roles: readonly AdminRole[], permissions?: readonly AdminPermission[]) {
  return {
    status: 200,
    body: permissions === undefined ? adminMe({ roles }) : adminMe({ roles, permissions }),
  };
}

function recovery(overrides: Partial<AdminAccountRecovery> = {}): AdminAccountRecovery {
  return {
    id: RECOVERY_ID,
    status: 'on_hold',
    customerId: CUSTOMER_ID,
    masterId: null,
    accountName: 'Leyla Hasanova',
    oldEmailMasked: 'l•••@example.com',
    newEmailMasked: 'n•••@example.com',
    evidenceNotes: 'Three facts matched.',
    openedByAdminId: OTHER_ADMIN,
    openedByName: 'Nigar Quliyeva',
    openedAt: '2026-11-10T09:00:00.000Z',
    codeExpiresAt: '2026-11-10T09:05:00.000Z',
    codeVerifiedAt: '2026-11-11T09:00:00.000Z',
    holdUntil: HOLD_UNTIL,
    cancelledAt: null,
    cancelSource: null,
    cancelledByAdminId: null,
    cancelledByName: null,
    cancelReason: null,
    approvedByAdminId: null,
    approvedByName: null,
    movedAt: null,
    ...overrides,
  };
}

function customer(overrides: Partial<AdminCustomerDetail> = {}): AdminCustomerDetail {
  return {
    id: CUSTOMER_ID,
    displayName: 'Leyla Hasanova',
    emailMasked: 'l•••@example.com',
    status: 'active',
    createdAt: '2026-08-01T09:00:00.000Z',
    orderCount: 1,
    lastOrderAt: '2026-09-20T09:00:00.000Z',
    statusReason: null,
    statusChangedAt: null,
    ratingCount: 0,
    orderCounts: {
      open: 0,
      completed: 1,
      cancelled: 0,
      disputed: 0,
      unfilled: 0,
      lateCancellations: 0,
    },
    addresses: [{ label: 'Ev', isDefault: true }],
    masterProfile: null,
    ...overrides,
  };
}

function order(): AdminOrderSummary {
  return {
    id: '3f2a9c1e-0000-4000-8000-000000000001',
    status: 'COMPLETED',
    serviceName: 'Santexnik',
    customerName: 'Leyla Hasanova',
    masterName: 'Usta Elçin',
    priceMinor: 4000,
    redispatchCount: 0,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T11:00:00.000Z',
  };
}

function master(): AdminMasterDetail {
  return {
    id: MASTER_ID,
    displayName: 'Rashad Aliyev',
    verificationStatus: 'active',
    suspendedAt: null,
    isAvailable: false,
    ratingCount: 4,
    createdAt: '2026-09-20T09:00:00.000Z',
    subscriptionStatus: null,
    bio: null,
    avatarUrl: null,
    services: [],
    documents: [],
    history: [],
    jobRecord: { handBacks: 0, lateArrivals: 0 },
  };
}

function customerServer(roles: readonly AdminRole[], permissions?: readonly AdminPermission[]) {
  return installFakeServer()
    .on('GET', '/api/admin/me', me(roles, permissions))
    .on('GET', CUSTOMER, { status: 200, body: customer() })
    .on('GET', `${CUSTOMER}/orders`, { status: 200, body: { items: [order()], nextCursor: null } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('who sees recovery (ADR-0074 § 3)', () => {
  it.each([
    ['support', ['support'], SUPPORT, true],
    ['moderator', ['moderator'], ['dashboard.read', 'customers.read', 'masters.read'], false],
    ['finance', ['finance'], ['dashboard.read', 'customers.read', 'masters.read'], false],
  ] as const)('%s', async (_, roles, permissions, sees) => {
    customerServer(roles, permissions);
    renderApp(`/customers/${CUSTOMER_ID}`);

    expect(await screen.findByRole('heading', { name: 'Leyla Hasanova' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    expect(Boolean(within(nav).queryByRole('link', { name: 'Account recovery' }))).toBe(sees);
    expect(Boolean(screen.queryByRole('button', { name: recoveriesCopy.open.button }))).toBe(sees);
  });
});

describe('the open requests', () => {
  it('lists each with its state, who opened it and the time left in the hold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    installFakeServer()
      .on('GET', '/api/admin/me', me(['super_admin']))
      .on('GET', LIST, {
        status: 200,
        body: [
          recovery(),
          recovery({
            id: '0b9e7d1c-0000-4000-8000-0000000000f2',
            status: 'awaiting_code',
            accountName: 'Rashad Aliyev',
            openedByAdminId: ME,
            openedByName: 'Aysel Mammadova',
            codeVerifiedAt: null,
            holdUntil: null,
          }),
        ],
      });
    renderApp('/recoveries');

    const table = await screen.findByRole('table', { name: 'Open recovery requests' });
    const held = within(table).getByRole('link', { name: 'Leyla Hasanova' }).closest('tr');
    expect(held).toHaveTextContent('On hold');
    expect(held).toHaveTextContent('Nigar Quliyeva');
    expect(held).toHaveTextContent('72 h 0 min left');
    const waiting = within(table).getByRole('link', { name: 'Rashad Aliyev' }).closest('tr');
    expect(waiting).toHaveTextContent('Waiting for the code');
    expect(waiting).toHaveTextContent('Aysel Mammadova (you)');
  });
});

describe('opening a customer’s recovery', () => {
  it('shows the account’s answers only after what the user said, and needs three matches', async () => {
    const server = customerServer(['support'], SUPPORT).on('POST', LIST, {
      status: 201,
      body: recovery({ status: 'awaiting_code', codeVerifiedAt: null, holdUntil: null }),
    });
    server.on('GET', DETAIL, {
      status: 200,
      body: recovery({ status: 'awaiting_code', codeVerifiedAt: null, holdUntil: null }),
    });
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);

    await user.click(await screen.findByRole('button', { name: recoveriesCopy.open.button }));
    const dialog = screen.getByRole('dialog', { name: recoveriesCopy.open.title });
    const facts = recoveriesCopy.open.customerFacts;

    // The account's answers are not on screen before the admin writes down the user's.
    expect(within(dialog).queryByText('Usta Elçin')).not.toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.saidLabel(facts.name)),
      'Leyla',
    );
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.saidLabel(facts.address)),
      'Ev',
    );
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.saidLabel(facts.master)),
      'Elçin',
    );
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.compare }));
    expect(within(dialog).getByText('Usta Elçin')).toBeInTheDocument();
    // Nothing said about an order: nothing to match there.
    expect(
      within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.matches(facts.order) }),
    ).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.newEmailLabel),
      'new@example.com',
    );
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.notesLabel),
      'Answered by email.',
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.matches(facts.name) }),
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.matches(facts.address) }),
    );
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.submit }));

    expect(within(dialog).getByText(recoveriesCopy.open.factsRequired(2))).toBeInTheDocument();
    expect(server.calls('POST', LIST)).toHaveLength(0);

    await user.click(
      within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.matches(facts.master) }),
    );
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.submit }));

    await waitFor(() => {
      expect(server.calls('POST', LIST)).toHaveLength(1);
    });
    const sent = server.calls('POST', LIST)[0]?.body as {
      subject: unknown;
      newEmail: string;
      evidenceNotes: string;
    };
    expect(sent.subject).toEqual({ kind: 'customer', id: CUSTOMER_ID });
    expect(sent.newEmail).toBe('new@example.com');
    expect(sent.evidenceNotes).toContain('Answered by email.');
    expect(sent.evidenceNotes).toContain(facts.master);
    // On to the request, where the code is entered.
    expect(
      await screen.findByRole('heading', { name: recoveriesCopy.codeTitle }),
    ).toBeInTheDocument();
  });

  it('sends a customer who is also a master to the master file', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on('GET', CUSTOMER, {
        status: 200,
        body: customer({ masterProfile: { id: MASTER_ID, displayName: 'Usta Elçin' } }),
      })
      .on('GET', `${CUSTOMER}/orders`, { status: 200, body: { items: [], nextCursor: null } });
    renderApp(`/customers/${CUSTOMER_ID}`);

    expect(await screen.findByText(recoveriesCopy.open.useMasterFile)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: recoveriesCopy.open.button }),
    ).not.toBeInTheDocument();
  });

  it.each([
    'ACCOUNT_RECOVERY_ALREADY_OPEN',
    'ACCOUNT_RECOVERY_CHANGE_PENDING',
    'ACCOUNT_RECOVERY_ACCOUNT_INACTIVE',
    'EMAIL_ADDRESS_TAKEN',
  ] as const)('says why the server refused: %s', async (code) => {
    customerServer(['support'], SUPPORT).on('POST', LIST, apiError(409, code));
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);
    await user.click(await screen.findByRole('button', { name: recoveriesCopy.open.button }));
    const dialog = screen.getByRole('dialog');
    const facts = recoveriesCopy.open.customerFacts;
    for (const fact of ['name', 'address', 'master'] as const) {
      await user.type(
        within(dialog).getByLabelText(recoveriesCopy.open.saidLabel(facts[fact])),
        'x',
      );
    }
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.compare }));
    for (const fact of ['name', 'address', 'master'] as const) {
      await user.click(
        within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.matches(facts[fact]) }),
      );
    }
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.newEmailLabel),
      'new@example.com',
    );
    await user.type(within(dialog).getByLabelText(recoveriesCopy.open.notesLabel), 'Notes.');
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.submit }));

    expect(await within(dialog).findByText(recoveriesCopy.errors[code])).toBeInTheDocument();
  });
});

describe('opening a master’s recovery', () => {
  it('cannot be opened without the document match confirmed', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on('GET', MASTER, { status: 200, body: master() })
      .on('GET', `${MASTER}/subscription`, {
        status: 200,
        body: { subscription: null, events: [] },
      })
      .on('POST', LIST, {
        status: 201,
        body: recovery({ status: 'awaiting_code', masterId: MASTER_ID }),
      })
      .on('GET', DETAIL, {
        status: 200,
        body: recovery({ status: 'awaiting_code', masterId: MASTER_ID }),
      });
    const { user } = renderApp(`/masters/${MASTER_ID}`);

    await user.click(await screen.findByRole('button', { name: recoveriesCopy.open.button }));
    const dialog = screen.getByRole('dialog', { name: recoveriesCopy.open.title });
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.newEmailLabel),
      'new@example.com',
    );
    await user.type(
      within(dialog).getByLabelText(recoveriesCopy.open.notesLabel),
      'Selfie and card front match.',
    );
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.submit }));

    expect(within(dialog).getByText(recoveriesCopy.open.masterMatchRequired)).toBeInTheDocument();
    expect(server.calls('POST', LIST)).toHaveLength(0);

    await user.click(
      within(dialog).getByRole('checkbox', { name: recoveriesCopy.open.masterMatch }),
    );
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.open.submit }));
    await waitFor(() => {
      expect(server.calls('POST', LIST)).toHaveLength(1);
    });
    expect(server.calls('POST', LIST)[0]?.body).toMatchObject({
      subject: { kind: 'master', id: MASTER_ID },
    });
  });
});

describe('the code from the new address', () => {
  it('starts the hold when it is right, and says so when it is not', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on(
        'GET',
        DETAIL,
        // A refusal refetches too (wrong codes can cancel the request), so the
        // request is still waiting the second time it is read.
        {
          status: 200,
          body: recovery({ status: 'awaiting_code', codeVerifiedAt: null, holdUntil: null }),
        },
        {
          status: 200,
          body: recovery({ status: 'awaiting_code', codeVerifiedAt: null, holdUntil: null }),
        },
        { status: 200, body: recovery() },
      )
      .on('POST', `${DETAIL}/verify`, apiError(422, 'ACCOUNT_RECOVERY_CODE_INVALID'), {
        status: 200,
        body: recovery(),
      });
    const { user } = renderApp(`/recoveries/${RECOVERY_ID}`);

    const field = await screen.findByLabelText(recoveriesCopy.codeLabel);
    await user.type(field, '111111');
    await user.click(screen.getByRole('button', { name: recoveriesCopy.confirmCode }));
    expect(
      await screen.findByText(recoveriesCopy.errors.ACCOUNT_RECOVERY_CODE_INVALID),
    ).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, '482915');
    await user.click(screen.getByRole('button', { name: recoveriesCopy.confirmCode }));
    expect(await screen.findByText('On hold')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/verify`).at(-1)?.body).toEqual({ code: '482915' });
  });
});

describe('approving the move', () => {
  it('is not offered to support', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on('GET', DETAIL, { status: 200, body: recovery({ status: 'ready' }) });
    renderApp(`/recoveries/${RECOVERY_ID}`);

    expect(await screen.findByText(recoveriesCopy.approveOnlySuperAdmin)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: recoveriesCopy.approve })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: recoveriesCopy.cancel })).toBeEnabled();
  });

  it('is disabled for the super admin who opened the request, with the reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
    installFakeServer()
      .on('GET', '/api/admin/me', me(['super_admin']))
      .on('GET', DETAIL, {
        status: 200,
        body: recovery({ status: 'ready', openedByAdminId: ME, openedByName: 'Aysel Mammadova' }),
      });
    renderApp(`/recoveries/${RECOVERY_ID}`);

    expect(await screen.findByRole('button', { name: recoveriesCopy.approve })).toBeDisabled();
    expect(screen.getByText(recoveriesCopy.approveNotOpener)).toBeInTheDocument();
  });

  it('waits for the hold, then moves the account (clock faked)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const before = installFakeServer()
      .on('GET', '/api/admin/me', me(['super_admin']))
      .on('GET', DETAIL, { status: 200, body: recovery() });
    const first = renderApp(`/recoveries/${RECOVERY_ID}`);
    expect(await screen.findByRole('button', { name: recoveriesCopy.approve })).toBeDisabled();
    expect(screen.getByText(/The hold ends/)).toBeInTheDocument();
    expect(before.calls('POST', `${DETAIL}/approve`)).toHaveLength(0);
    first.unmount();

    // Three days on.
    vi.setSystemTime(new Date('2026-11-14T10:01:00.000Z'));
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me(['super_admin']))
      .on(
        'GET',
        DETAIL,
        { status: 200, body: recovery({ status: 'ready' }) },
        {
          status: 200,
          body: recovery({
            status: 'moved',
            approvedByAdminId: ME,
            approvedByName: 'Aysel Mammadova',
            movedAt: '2026-11-14T10:01:00.000Z',
          }),
        },
      )
      .on('POST', `${DETAIL}/approve`, {
        status: 200,
        body: recovery({
          status: 'moved',
          approvedByAdminId: ME,
          movedAt: '2026-11-14T10:01:00.000Z',
        }),
      });
    const { user } = renderApp(`/recoveries/${RECOVERY_ID}`);

    await user.click(await screen.findByRole('button', { name: recoveriesCopy.approve }));
    const dialog = screen.getByRole('dialog', { name: recoveriesCopy.approveTitle });
    await user.type(within(dialog).getByRole('textbox'), 'Evidence matched; nobody objected.');
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.approve }));

    expect(await screen.findByText(recoveriesCopy.moved)).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/approve`)[0]?.body).toEqual({
      reason: 'Evidence matched; nobody objected.',
    });
  });

  it.each([
    'ACCOUNT_RECOVERY_HOLD_RUNNING',
    'ACCOUNT_RECOVERY_SAME_ADMIN',
    'ACCOUNT_RECOVERY_NOT_ALLOWED_NOW',
    'EMAIL_ADDRESS_TAKEN',
  ] as const)('says why the server refused: %s', async (code) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
    installFakeServer()
      .on('GET', '/api/admin/me', me(['super_admin']))
      .on('GET', DETAIL, { status: 200, body: recovery({ status: 'ready' }) })
      .on('POST', `${DETAIL}/approve`, apiError(409, code));
    const { user } = renderApp(`/recoveries/${RECOVERY_ID}`);

    await user.click(await screen.findByRole('button', { name: recoveriesCopy.approve }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Checked.');
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.approve }));

    expect(await within(dialog).findByText(recoveriesCopy.errors[code])).toBeInTheDocument();
  });
});

describe('cancelling and revealing', () => {
  it('cancels with a reason', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on(
        'GET',
        DETAIL,
        { status: 200, body: recovery() },
        {
          status: 200,
          body: recovery({
            status: 'cancelled',
            cancelledAt: '2026-11-11T10:05:00.000Z',
            cancelSource: 'admin',
            cancelledByAdminId: ME,
            cancelledByName: 'Aysel Mammadova',
            cancelReason: 'The user called.',
          }),
        },
      )
      .on('POST', `${DETAIL}/cancel`, { status: 200, body: recovery({ status: 'cancelled' }) });
    const { user } = renderApp(`/recoveries/${RECOVERY_ID}`);

    await user.click(await screen.findByRole('button', { name: recoveriesCopy.cancel }));
    const dialog = screen.getByRole('dialog', { name: recoveriesCopy.cancelTitle });
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.cancel }));
    expect(within(dialog).getByText(recoveriesCopy.reasonEmpty)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'The user called.');
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.cancel }));

    expect(await screen.findByText('The user called.')).toBeInTheDocument();
    expect(screen.getByText(/by an admin/)).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/cancel`)[0]?.body).toEqual({
      reason: 'The user called.',
    });
  });

  it('shows both addresses only after a reason', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me(['support'], SUPPORT))
      .on('GET', DETAIL, { status: 200, body: recovery() })
      .on('POST', `${DETAIL}/emails`, {
        status: 200,
        body: { oldEmail: 'leyla@example.com', newEmail: 'leyla.new@example.com' },
      });
    const { user } = renderApp(`/recoveries/${RECOVERY_ID}`);

    expect(await screen.findByText('l•••@example.com')).toBeInTheDocument();
    expect(screen.queryByText('leyla@example.com')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: recoveriesCopy.revealEmails }));
    const dialog = screen.getByRole('dialog', { name: recoveriesCopy.revealTitle });
    await user.type(within(dialog).getByRole('textbox'), 'Matching the sender.');
    await user.click(within(dialog).getByRole('button', { name: recoveriesCopy.reveal }));

    // The dialog turns into the one that shows both addresses.
    const shown = await screen.findByRole('dialog', { name: recoveriesCopy.revealTitle });
    expect(await within(shown).findByText('leyla.new@example.com')).toBeInTheDocument();
    expect(within(shown).getByText('leyla@example.com')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/emails`)[0]?.body).toEqual({
      reason: 'Matching the sender.',
    });
  });
});

describe('the refusal messages', () => {
  it('names a refused send budget, which the server answers with a 503', () => {
    expect(recoveryErrorMessage({ status: 503, code: undefined })).toBe(
      recoveriesCopy.errors.sendRefused,
    );
    expect(recoveryErrorMessage({ status: 'network', code: undefined })).toBe(
      recoveriesCopy.errors.unexpected,
    );
  });
});
