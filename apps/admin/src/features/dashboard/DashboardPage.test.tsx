import type { AdminDashboard } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';
import { formatAge, formatRate } from './DashboardPage';

const DAY_MS = 24 * 60 * 60 * 1000;

const DASHBOARD: AdminDashboard = {
  from: '2026-09-17T12:00:00.000Z',
  to: '2026-09-24T12:00:00.000Z',
  cellDegrees: 0.02,
  orders: {
    created: 40,
    filled: 25,
    unfilled: 6,
    searching: 3,
    cancelled: 5,
    cancelledAfterAccept: 2,
    cancelledBy: [
      { actorKind: 'customer', count: 4 },
      { actorKind: 'master', count: 1 },
    ],
    fillRate: 0.625,
    unfilledRate: 0.15,
    cancellationRate: 0.125,
  },
  unfilledByCategory: [
    { categoryId: '11111111-1111-4111-8111-111111111111', categoryName: 'Santexnika', count: 4 },
    { categoryId: '22222222-2222-4222-8222-222222222222', categoryName: 'Qıfıllar', count: 2 },
  ],
  unfilledByArea: [{ lat: 40.38012345, lng: 49.85067891, count: 5 }],
  mastersAvailable: { total: 12, byArea: [{ lat: 40.41, lng: 49.87, count: 7 }] },
  openDisputes: { count: 2, oldestDisputedAt: '2026-09-21T09:00:00.000Z' },
};

function dashboardServer() {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
    .on('GET', '/api/admin/dashboard', { status: 200, body: DASHBOARD });
}

function tile(label: string): HTMLElement {
  const figures = screen.getByRole('list', { name: 'Key figures' });
  const item = within(figures)
    .getAllByRole('listitem')
    .find((li) => li.firstChild?.textContent === label);
  if (item === undefined) throw new Error(`No tile "${label}"`);
  return item;
}

describe('dashboard', () => {
  it('shows every key figure with its rate against created orders', async () => {
    dashboardServer();
    renderApp('/');

    await screen.findByRole('list', { name: 'Key figures' });
    expect(tile('Orders created')).toHaveTextContent('40');
    expect(tile('Filled')).toHaveTextContent(`25${String(formatRate(0.625))} of created`);
    expect(tile('Unfilled')).toHaveTextContent(`6${String(formatRate(0.15))} of created`);
    expect(tile('Cancelled')).toHaveTextContent(`5${String(formatRate(0.125))} of created`);
    expect(tile('Cancelled after accept')).toHaveTextContent('2');
    expect(tile('Searching now')).toHaveTextContent('3');
    expect(tile('Open disputes')).toHaveTextContent(
      `2Oldest open for ${formatAge('2026-09-21T09:00:00.000Z')}`,
    );
    expect(tile('Masters available now')).toHaveTextContent('12');
  });

  it('says in so many words that unfilled is not a cancellation', async () => {
    dashboardServer();
    renderApp('/');

    expect(
      await screen.findByText(/Unfilled means no master was found \(NO_MASTER_FOUND\)/),
    ).toHaveTextContent('not a cancellation');
  });

  it('lists supply gaps in tables, areas by a rounded centre with a map link', async () => {
    dashboardServer();
    renderApp('/');

    const byCategory = await screen.findByRole('table', { name: 'Unfilled orders by category' });
    expect(
      within(byCategory)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual(['Santexnika4', 'Qıfıllar2']);

    const byArea = screen.getByRole('table', { name: 'Unfilled orders by area' });
    expect(within(byArea).getByText('40.380, 49.851')).toBeInTheDocument();
    const link = within(byArea).getByRole('link', { name: 'Open in Google Maps' });
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps?q=40.380,49.851');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const masters = screen.getByRole('table', { name: 'Masters available now by area' });
    expect(within(masters).getByText('40.410, 49.870')).toBeInTheDocument();

    const cancelledBy = screen.getByRole('table', { name: 'Cancellations by who cancelled' });
    expect(within(cancelledBy).getByText('Customer')).toBeInTheDocument();
  });

  it('asks for the last seven days first and a new range when another preset is chosen', async () => {
    const server = dashboardServer();
    const { user } = renderApp('/');
    await screen.findByRole('list', { name: 'Key figures' });

    const span = (index: number) => {
      const search = server.calls('GET', '/api/admin/dashboard')[index]?.search;
      return Date.parse(search?.get('to') ?? '') - Date.parse(search?.get('from') ?? '');
    };
    expect(span(0)).toBe(7 * DAY_MS);

    await user.selectOptions(screen.getByLabelText('Range'), '30d');
    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/dashboard')).toHaveLength(2);
    });
    expect(span(1)).toBe(30 * DAY_MS);

    await user.selectOptions(screen.getByLabelText('Range'), '90d');
    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/dashboard')).toHaveLength(3);
    });
    expect(span(2)).toBe(90 * DAY_MS);
  });

  it('explains a refused range', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', '/api/admin/dashboard', apiError(422, 'VALIDATION_FAILED'));
    renderApp('/');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server refused this range. It allows at most 90 days.',
    );
  });
});
