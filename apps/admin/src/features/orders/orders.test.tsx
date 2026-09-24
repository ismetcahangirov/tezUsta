import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrderTranscript,
  AdminPermission,
} from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';
import { formatMoney } from '../../format';

const ORDER_ID = '3f2a9c1e-0000-4000-8000-000000000001';
const PHOTO_ID = '00000000-0000-4000-8000-0000000000f1';
const LIST = '/api/admin/orders';
const DISPUTES = '/api/admin/orders/disputes';
const DETAIL = `/api/admin/orders/${ORDER_ID}`;

function summary(overrides: Partial<AdminOrderSummary> = {}): AdminOrderSummary {
  return {
    id: ORDER_ID,
    status: 'DISPUTED',
    serviceName: 'Santexnik',
    customerName: 'Leyla Hasanova',
    masterName: 'Rashad Aliyev',
    priceMinor: 4550,
    redispatchCount: 1,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  return {
    ...summary(),
    description: 'The kitchen tap leaks under the sink.',
    acceptedAt: '2026-09-20T09:10:00.000Z',
    address: {
      formattedAddress: 'Nizami küç. 10, Bakı',
      building: '10',
      entrance: null,
      floor: '4',
      apartment: '12',
      landmarkNote: null,
    },
    customer: { id: 'c1', displayName: 'Leyla Hasanova', phoneMasked: '+994 •• ••• •• 67' },
    master: { id: 'm1', displayName: 'Rashad Aliyev', phoneMasked: '+994 •• ••• •• 21' },
    history: [
      {
        fromStatus: 'SEARCHING',
        toStatus: 'ACCEPTED',
        actorKind: 'master',
        actorAdminName: null,
        reason: null,
        createdAt: '2026-09-20T09:10:00.000Z',
      },
      {
        fromStatus: 'COMPLETED',
        toStatus: 'DISPUTED',
        actorKind: 'customer',
        actorAdminName: null,
        reason: 'The leak came back the next day.',
        createdAt: '2026-09-21T09:00:00.000Z',
      },
    ],
    photos: [{ id: PHOTO_ID, status: 'attached', createdAt: '2026-09-20T09:01:00.000Z' }],
    transitions: [
      { to: 'RESOLVED', available: true },
      { to: 'REFUNDED', available: false },
    ],
    transcriptAvailable: true,
    ...overrides,
  };
}

/**
 * What the page shows for an amount, through the page's own formatter. ICU
 * puts a no-break space in it, which Testing Library collapses in the DOM text
 * but not in the matcher, so the matcher is collapsed the same way.
 */
function money(minor: number): string {
  return formatMoney(minor).replace(/\s+/g, ' ');
}

function page(items: AdminOrderSummary[], nextCursor: string | null = null) {
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

describe('order list', () => {
  it('lists every order with its price in manat', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, page([summary()]));
    renderApp('/orders');

    const table = await screen.findByRole('table', { name: 'Orders' });
    expect(within(table).getByRole('link', { name: '3f2a9c1e' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
    expect(within(table).getByText('Leyla Hasanova')).toBeInTheDocument();
    expect(within(table).getByText(money(4550))).toBeInTheDocument();
    const request = server.calls('GET', LIST)[0];
    expect(request?.search.has('status')).toBe(false);
    expect(request?.search.has('stuck')).toBe(false);
  });

  it('sends the chosen statuses, the stuck filter and the date range', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, page([summary()]));
    const { user } = renderApp('/orders');
    await screen.findByRole('table', { name: 'Orders' });

    await user.click(screen.getByRole('checkbox', { name: 'Disputed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Accepted' }));
    await waitFor(() =>
      expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('ACCEPTED,DISPUTED'),
    );

    await user.click(screen.getByRole('checkbox', { name: 'Stuck only' }));
    await waitFor(() => expect(server.calls('GET', LIST).at(-1)?.search.get('stuck')).toBe('true'));

    await user.type(screen.getByLabelText('Created from'), '2026-09-01');
    await user.type(screen.getByLabelText('Created to'), '2026-09-24');
    await waitFor(() => {
      const last = server.calls('GET', LIST).at(-1);
      expect(last?.search.get('from')).toBe(new Date(2026, 8, 1).toISOString());
      // The whole of the chosen day: the API's upper bound is exclusive.
      expect(last?.search.get('to')).toBe(new Date(2026, 8, 25).toISOString());
    });
    expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('ACCEPTED,DISPUTED');

    await user.click(screen.getByRole('checkbox', { name: 'Disputed' }));
    await waitFor(() =>
      expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('ACCEPTED'),
    );
  });

  it('loads more orders with the cursor the server returned', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, (request) =>
        request.search.get('cursor') === 'next'
          ? page([summary({ id: '99999999-0000-4000-8000-000000000002' })])
          : page([summary()], 'next'),
      );
    const { user } = renderApp('/orders');

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: '99999999' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3f2a9c1e' })).toBeInTheDocument();
    expect(server.calls('GET', LIST).at(-1)?.search.get('cursor')).toBe('next');
  });
});

describe('dispute queue', () => {
  it('lists the disputed orders the queue returns and links to each', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DISPUTES, page([summary()]));
    renderApp('/disputes');

    const table = await screen.findByRole('table', { name: 'Disputed orders' });
    expect(within(table).getByRole('link', { name: '3f2a9c1e' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
    expect(server.calls('GET', DISPUTES)).toHaveLength(1);
  });

  it('says so when there is nothing to resolve', async () => {
    installFakeServer().on('GET', '/api/admin/me', me()).on('GET', DISPUTES, page([]));
    renderApp('/disputes');

    expect(await screen.findByText('No open disputes.')).toBeInTheDocument();
  });
});

describe('order detail', () => {
  it('shows the summary, the address, the parties with masked numbers, and the history oldest first', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/orders/${ORDER_ID}`);

    expect(await screen.findByRole('heading', { name: 'Order 3f2a9c1e' })).toBeInTheDocument();
    expect(screen.getByText('The kitchen tap leaks under the sink.')).toBeInTheDocument();
    expect(screen.getByText(money(4550))).toBeInTheDocument();
    expect(screen.getByText('Nizami küç. 10, Bakı')).toBeInTheDocument();
    expect(screen.getByText('+994 •• ••• •• 67')).toBeInTheDocument();
    expect(screen.getByText('+994 •• ••• •• 21')).toBeInTheDocument();

    const history = within(screen.getByRole('list', { name: 'Status history' })).getAllByRole(
      'listitem',
    );
    expect(history[0]).toHaveTextContent('Searching → Accepted');
    expect(history[1]).toHaveTextContent('Completed → Disputed');
    expect(history[1]).toHaveTextContent('The leak came back the next day.');
  });

  it('resolves a dispute with a reason, and the override appears in the history', async () => {
    const resolved = detail({
      status: 'RESOLVED',
      transitions: [],
      transcriptAvailable: false,
      history: [
        ...detail().history,
        {
          fromStatus: 'DISPUTED',
          toStatus: 'RESOLVED',
          actorKind: 'admin',
          actorAdminName: 'Aysel Mammadova',
          reason: 'Master revisited and fixed the leak.',
          createdAt: '2026-09-22T09:00:00.000Z',
        },
      ],
    });
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() }, { status: 200, body: resolved })
      .on('POST', `${DETAIL}/transitions`, { status: 200, body: {} });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the order’s status' });

    // Exactly the server's edges — nothing the client worked out itself.
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    const submit = within(dialog).getByRole('button', { name: 'Change status' });
    await user.click(submit);
    expect(within(dialog).getByText('Choose a new status.')).toBeInTheDocument();
    expect(within(dialog).getByText('Write a reason.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: 'Resolved' }));
    await user.click(submit);
    expect(server.calls('POST', `${DETAIL}/transitions`)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Reason' }),
      'Master revisited and fixed the leak.',
    );
    await user.click(submit);

    expect(await screen.findByText('The order is now Resolved.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/transitions`)[0]?.body).toEqual({
      to: 'RESOLVED',
      reason: 'Master revisited and fixed the leak.',
    });
    const history = within(await screen.findByRole('list', { name: 'Status history' }));
    await waitFor(() => expect(history.getByText('Disputed → Resolved')).toBeInTheDocument());
    expect(history.getByText('by Aysel Mammadova', { exact: false })).toBeInTheDocument();
    expect(history.getByText('Master revisited and fixed the leak.')).toBeInTheDocument();
    // A resolved order has nowhere left to go.
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
  });

  it('shows REFUNDED disabled with the explanation', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Change status' }));

    const refunded = within(screen.getByRole('dialog')).getByRole('radio', { name: 'Refunded' });
    expect(refunded).toBeDisabled();
    expect(refunded).toHaveAccessibleDescription(
      'Refunds are unavailable until a payment provider is connected',
    );
  });

  it('disables a move the admin’s role cannot make', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['orders.read', 'orders.override']))
      .on('GET', DETAIL, { status: 200, body: detail() });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Change status' }));

    const resolvedOption = within(screen.getByRole('dialog')).getByRole('radio', {
      name: 'Resolved',
    });
    expect(resolvedOption).toBeDisabled();
    expect(resolvedOption).toHaveAccessibleDescription('Your role cannot make this change.');
  });

  it('hides the override from an admin who holds none of its permissions', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['orders.read']))
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/orders/${ORDER_ID}`);

    await screen.findByRole('heading', { name: 'Order 3f2a9c1e' });
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reveal number/ })).not.toBeInTheDocument();
  });

  it('shows the message for the error code the server returns', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/transitions`, apiError(409, 'ORDER_INVALID_TRANSITION'));
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Resolved' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Closing it.');
    await user.click(within(dialog).getByRole('button', { name: 'Change status' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The order can no longer make this move',
    );
    await waitFor(() => expect(server.calls('GET', DETAIL)).toHaveLength(2));
  });

  it('reveals a number once, for a reason, and forgets it when the dialog closes', async () => {
    const reveal = `${DETAIL}/parties/customer/phone`;
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', reveal, { status: 200, body: { phoneE164: '+994501234567' } });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reveal number: Customer' }));
    const dialog = screen.getByRole('dialog', { name: 'Reveal Leyla Hasanova’s number' });
    await user.click(within(dialog).getByRole('button', { name: 'Reveal' }));
    expect(within(dialog).getByText('Write a reason.')).toBeInTheDocument();
    expect(server.calls('POST', reveal)).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Reason' }),
      'Customer asked to be called back.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reveal' }));

    expect(await within(dialog).findByText('+994501234567')).toBeInTheDocument();
    expect(server.calls('POST', reveal)[0]?.body).toEqual({
      reason: 'Customer asked to be called back.',
    });

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('+994501234567')).not.toBeInTheDocument();

    // Opening it again is a new reveal: the form, not the number.
    await user.click(screen.getByRole('button', { name: 'Reveal number: Customer' }));
    expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Reason' })).toHaveValue(
      '',
    );
    expect(screen.queryByText('+994501234567')).not.toBeInTheDocument();
  });

  it('explains a refused reveal', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/parties/master/phone`, apiError(403, 'FORBIDDEN'));
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reveal number: Master' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Dispute call.');
    await user.click(within(dialog).getByRole('button', { name: 'Reveal' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your role does not allow this action.',
    );
  });

  it('loads the transcript only when asked', async () => {
    const transcript: AdminOrderTranscript = {
      conversations: [
        {
          id: 'conv-1',
          masterId: 'm1',
          openedAt: '2026-09-20T09:10:00.000Z',
          closedAt: null,
          messages: [
            {
              id: 'msg-1',
              senderKind: 'customer',
              body: 'Are you still coming?',
              createdAt: '2026-09-20T09:20:00.000Z',
            },
            {
              id: 'msg-2',
              senderKind: 'master',
              body: 'Ten minutes away.',
              createdAt: '2026-09-20T09:21:00.000Z',
            },
          ],
        },
      ],
    };
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', `${DETAIL}/transcript`, { status: 200, body: transcript });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Show transcript' }));

    expect(await screen.findByText('Are you still coming?')).toBeInTheDocument();
    expect(screen.getByText('Ten minutes away.')).toBeInTheDocument();
    expect(server.calls('GET', `${DETAIL}/transcript`)).toHaveLength(1);
  });

  it('offers no transcript for an order that is not disputed', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, {
        status: 200,
        body: detail({ status: 'IN_PROGRESS', transcriptAvailable: false }),
      });
    renderApp(`/orders/${ORDER_ID}`);

    await screen.findByRole('heading', { name: 'Order 3f2a9c1e' });
    expect(screen.queryByRole('button', { name: 'Show transcript' })).not.toBeInTheDocument();
    expect(server.calls('GET', `${DETAIL}/transcript`)).toHaveLength(0);
  });

  it('opens a photo through the audited download URL', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const download = `${DETAIL}/photos/${PHOTO_ID}/download`;
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('GET', download, {
        status: 200,
        body: { url: 'https://storage.test/photo?sig=1', expiresAt: '2026-09-24T10:05:00.000Z' },
      });
    const { user } = renderApp(`/orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Open Photo 1' }));

    await waitFor(() => expect(tab.location.href).toBe('https://storage.test/photo?sig=1'));
    expect(server.calls('GET', download)).toHaveLength(1);
  });
});
