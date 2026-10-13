import type {
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminOrderSummary,
  AdminPermission,
} from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const CUSTOMER_ID = '0b9e7d1c-0000-4000-8000-000000000001';
const MASTER_ID = '0b9e7d1c-0000-4000-8000-0000000000aa';
const LIST = '/api/admin/customers';
const DETAIL = `${LIST}/${CUSTOMER_ID}`;
const ORDERS = `${DETAIL}/orders`;

function summary(overrides: Partial<AdminCustomerSummary> = {}): AdminCustomerSummary {
  return {
    id: CUSTOMER_ID,
    displayName: 'Leyla Hasanova',
    phoneMasked: '+994 •• ••• •• 67',
    status: 'active',
    createdAt: '2026-08-01T09:00:00.000Z',
    orderCount: 3,
    lastOrderAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminCustomerDetail> = {}): AdminCustomerDetail {
  return {
    ...summary(),
    statusReason: null,
    statusChangedAt: null,
    ratingCount: 2,
    orderCounts: { open: 1, completed: 1, cancelled: 1, disputed: 0, unfilled: 0 },
    addresses: [
      { label: 'Ev', isDefault: true },
      { label: null, isDefault: false },
    ],
    masterProfile: null,
    ...overrides,
  };
}

function order(overrides: Partial<AdminOrderSummary> = {}): AdminOrderSummary {
  return {
    id: '3f2a9c1e-0000-4000-8000-000000000001',
    status: 'SEARCHING',
    serviceName: 'Santexnik',
    customerName: 'Leyla Hasanova',
    masterName: null,
    priceMinor: null,
    redispatchCount: 0,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

function page<T>(items: T[], nextCursor: string | null = null) {
  return { status: 200, body: { items, nextCursor } };
}

function me(permissions?: readonly AdminPermission[]) {
  return {
    status: 200,
    body: permissions === undefined ? adminMe() : adminMe({ roles: ['support'], permissions }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('customer list (#328)', () => {
  it('lists customers with a masked number and links each to their file', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, page([summary()]));
    renderApp('/customers');

    const table = await screen.findByRole('table', { name: 'Customers' });
    expect(within(table).getByRole('link', { name: 'Leyla Hasanova' })).toHaveAttribute(
      'href',
      `/customers/${CUSTOMER_ID}`,
    );
    expect(within(table).getByText('+994 •• ••• •• 67')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
  });

  it('sends the search and the status filter to the server, and keeps them in the URL', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, page([summary()]));
    const { user } = renderApp('/customers');
    await screen.findByRole('table', { name: 'Customers' });

    await user.type(screen.getByRole('textbox', { name: 'Search' }), '+994501234567');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(server.calls('GET', LIST).at(-1)?.search.get('q')).toBe('+994501234567');
    });
    expect(window.location.search).toContain('q=%2B994501234567');

    await user.click(screen.getByRole('tab', { name: 'Suspended' }));
    await waitFor(() => {
      expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('suspended');
    });
    expect(server.calls('GET', LIST).at(-1)?.search.get('q')).toBe('+994501234567');
  });

  it('says so when nobody matches', async () => {
    installFakeServer().on('GET', '/api/admin/me', me()).on('GET', LIST, page([]));
    renderApp('/customers?q=%2B99450');
    expect(await screen.findByText('No customers match this search.')).toBeInTheDocument();
  });

  it('is in the navigation for a role that reads customers, and absent otherwise', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['dashboard.read', 'orders.read']))
      .on('GET', '/api/admin/dashboard', { status: 200, body: {} });
    renderApp('/');
    const nav = await screen.findByRole('navigation');
    expect(within(nav).queryByRole('link', { name: 'Customers' })).not.toBeInTheDocument();
  });
});

describe('customer file (#328)', () => {
  it('shows the profile, the counts, address labels and the order history', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, {
        status: 200,
        body: detail({ masterProfile: { id: MASTER_ID, displayName: 'Usta Elçin' } }),
      })
      .on('GET', ORDERS, page([order()]));
    renderApp(`/customers/${CUSTOMER_ID}`);

    expect(await screen.findByRole('heading', { name: 'Leyla Hasanova' })).toBeInTheDocument();
    expect(screen.getByText('+994 •• ••• •• 67')).toBeInTheDocument();
    expect(screen.getByText('Ev')).toBeInTheDocument();
    expect(screen.getByText('Unnamed address')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usta Elçin' })).toHaveAttribute(
      'href',
      `/masters/${MASTER_ID}`,
    );
    const orders = await screen.findByRole('table', { name: 'This customer’s orders' });
    expect(within(orders).getByRole('link', { name: '3f2a9c1e' })).toBeInTheDocument();
  });

  it('shows why and since when a suspended account was suspended', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, {
        status: 200,
        body: detail({
          status: 'suspended',
          statusReason: 'Saxta sifarişlər',
          statusChangedAt: '2026-10-01T10:00:00.000Z',
        }),
      })
      .on('GET', ORDERS, page([]));
    renderApp(`/customers/${CUSTOMER_ID}`);

    expect(await screen.findByText('Saxta sifarişlər')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reinstate account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend account' })).not.toBeInTheDocument();
  });

  it('suspends with a reason, warns about the master profile, and lists what support must follow up', async () => {
    const followUp = '7a1b2c3d-0000-4000-8000-000000000002';
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, {
        status: 200,
        body: detail({ masterProfile: { id: MASTER_ID, displayName: 'Usta Elçin' } }),
      })
      .on('GET', ORDERS, page([]))
      .on('POST', `${DETAIL}/suspend`, {
        status: 200,
        body: {
          customer: summary({ status: 'suspended' }),
          cancelledOrderIds: ['3f2a9c1e-0000-4000-8000-000000000001'],
          followUpOrderIds: [followUp],
        },
      });
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend this account?' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Usta Elçin');

    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(within(dialog).getByText('Write a reason.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/suspend`)).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Saxta sifarişlər');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));

    expect(
      await screen.findByText('The account is suspended. 1 searching order was cancelled.'),
    ).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/suspend`)[0]?.body).toEqual({
      reason: 'Saxta sifarişlər',
    });
    expect(screen.getByRole('link', { name: '7a1b2c3d' })).toHaveAttribute(
      'href',
      `/orders/${followUp}`,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not warn about a master profile the account does not have', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', ORDERS, page([]));
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend this account?' });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the account and number actions from a role without them', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['customers.read', 'orders.read']))
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', ORDERS, page([]));
    renderApp(`/customers/${CUSTOMER_ID}`);

    expect(await screen.findByRole('heading', { name: 'Leyla Hasanova' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal number' })).not.toBeInTheDocument();
  });

  it('explains a suspension the server refused with 403', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', ORDERS, page([]))
      .on('POST', `${DETAIL}/suspend`, apiError(403, 'FORBIDDEN'));
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Suspend account' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Şikayət');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your role does not allow this action.',
    );
  });

  it('reveals the number once, for a reason', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', ORDERS, page([]))
      .on('POST', `${DETAIL}/phone`, { status: 200, body: { phoneE164: '+994501234567' } });
    const { user } = renderApp(`/customers/${CUSTOMER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reveal number' }));
    const dialog = screen.getByRole('dialog', { name: 'Reveal Leyla Hasanova’s number' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Zəng istədi.');
    await user.click(within(dialog).getByRole('button', { name: 'Reveal' }));

    expect(await within(dialog).findByText('+994501234567')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/phone`)[0]?.body).toEqual({ reason: 'Zəng istədi.' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('+994501234567')).not.toBeInTheDocument();
  });

  it('says there is no such customer for a 404', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, apiError(404, 'NOT_FOUND'));
    renderApp(`/customers/${CUSTOMER_ID}`);
    expect(await screen.findByText('There is no customer with this id.')).toBeInTheDocument();
  });
});
