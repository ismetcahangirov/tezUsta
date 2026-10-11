import type { AdminSubscription } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS, adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';
import { formatAzn } from '../catalogue/money';

/** An amount as the page shows it, with the DOM's whitespace normalisation applied. */
function money(minor: number): string {
  return formatAzn(minor).replace(/\s/g, ' ');
}

const OFFER_URL = '/api/admin/subscription';
const MONTHLY_ID = '00000000-0000-4000-8000-0000000000f1';
const YEARLY_ID = '00000000-0000-4000-8000-0000000000f2';
const SCHEDULED_ID = '00000000-0000-4000-8000-0000000000f3';
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';

function offer(overrides: Partial<AdminSubscription> = {}): AdminSubscription {
  return {
    monthly: {
      billingPeriod: 'monthly',
      priceMinor: 2_000,
      currency: 'AZN',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
    },
    yearly: {
      billingPeriod: 'yearly',
      priceMinor: 20_000,
      currency: 'AZN',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
    },
    scheduled: {
      monthly: {
        id: SCHEDULED_ID,
        billingPeriod: 'monthly',
        priceMinor: 2_500,
        effectiveFrom: '2026-11-15T00:00:00.000Z',
        createdAt: '2026-10-10T09:00:00.000Z',
        createdByAdminId: ADMIN_ID,
        withdrawsPriceId: null,
        state: 'scheduled',
      },
      yearly: null,
    },
    trialDays: 14,
    graceDays: 3,
    purchasesOpen: true,
    priceChangeNoticeDays: 30,
    noticeRequired: { monthly: true, yearly: false },
    priceHistory: [
      {
        id: SCHEDULED_ID,
        billingPeriod: 'monthly',
        priceMinor: 2_500,
        effectiveFrom: '2026-11-15T00:00:00.000Z',
        createdAt: '2026-10-10T09:00:00.000Z',
        createdByAdminId: ADMIN_ID,
        withdrawsPriceId: null,
        state: 'scheduled',
      },
      {
        id: MONTHLY_ID,
        billingPeriod: 'monthly',
        priceMinor: 2_000,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        createdByAdminId: ADMIN_ID,
        withdrawsPriceId: null,
        state: 'current',
      },
      {
        id: YEARLY_ID,
        billingPeriod: 'yearly',
        priceMinor: 20_000,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        createdByAdminId: ADMIN_ID,
        withdrawsPriceId: null,
        state: 'current',
      },
    ],
    ...overrides,
  };
}

function server(me = adminMe()) {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: me })
    .on('GET', OFFER_URL, { status: 200, body: offer() });
}

describe('the subscription page (#324)', () => {
  it('shows both prices, the scheduled change, the settings and the price history', async () => {
    server();
    renderApp('/subscription');

    expect((await screen.findAllByText(money(2_000))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(money(20_000)).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${money(2_500)} from`))).toBeInTheDocument();
    expect(screen.getByText('14 days')).toBeInTheDocument();
    expect(screen.getByText('3 days')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();

    const history = screen.getByRole('table', {
      name: 'Every price version ever entered, newest first',
    });
    const rows = within(history).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText('Scheduled')).toBeInTheDocument();
  });

  it('changes a price, asking to confirm a large change the server flagged', async () => {
    const api = server().on(
      'PUT',
      `${OFFER_URL}/prices`,
      apiError(422, 'SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED'),
      { status: 200, body: offer() },
    );
    const { user } = renderApp('/subscription');

    await user.click(await screen.findByRole('button', { name: 'Change prices' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Yearly price (AZN)' }), '200');
    await user.type(dialog.getByRole('textbox', { name: 'Reason' }), 'New yearly price.');
    await user.click(dialog.getByRole('button', { name: 'Save prices' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('This is a large change');
    await user.click(
      dialog.getByRole('checkbox', { name: 'I have checked this amount: it is a large change.' }),
    );
    await user.click(dialog.getByRole('button', { name: 'Save prices' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const calls = api.calls('PUT', `${OFFER_URL}/prices`);
    expect(calls[0]?.body).toEqual({ yearlyMinor: 20_000, reason: 'New yearly price.' });
    expect(calls[1]?.body).toEqual({
      yearlyMinor: 20_000,
      confirmLargeChange: true,
      reason: 'New yearly price.',
    });
  });

  it('refuses an amount it cannot read before asking the server', async () => {
    const api = server();
    const { user } = renderApp('/subscription');

    await user.click(await screen.findByRole('button', { name: 'Change prices' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Monthly price (AZN)' }), '20,999');
    await user.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Typo.');
    await user.click(dialog.getByRole('button', { name: 'Save prices' }));

    expect(
      dialog.getByRole('textbox', { name: 'Monthly price (AZN)' }),
    ).toHaveAccessibleDescription('Enter an amount like 20 or 19.90.');
    expect(api.calls('PUT', `${OFFER_URL}/prices`)).toHaveLength(0);
  });

  it('shows the server’s validation error', async () => {
    server().on('PUT', `${OFFER_URL}/settings`, apiError(422, 'VALIDATION_FAILED'));
    const { user } = renderApp('/subscription');

    await user.click(await screen.findByRole('button', { name: 'Change settings' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Shorter grace.');
    await user.click(dialog.getByRole('button', { name: 'Save settings' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('Some values were not accepted');
  });

  it('explains why purchases cannot open yet', async () => {
    const api = server().on(
      'PUT',
      `${OFFER_URL}/settings`,
      apiError(409, 'SUBSCRIPTION_PURCHASES_NEED_PRICES'),
    );
    const { user } = renderApp('/subscription');

    await user.click(await screen.findByRole('button', { name: 'Change settings' }));
    const dialog = within(screen.getByRole('dialog'));
    const trial = dialog.getByRole('textbox', { name: 'Trial (days, 0–90)' });
    await user.clear(trial);
    await user.type(trial, '30');
    await user.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Longer trial.');
    await user.click(dialog.getByRole('button', { name: 'Save settings' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('Purchases cannot open');
    expect(api.calls('PUT', `${OFFER_URL}/settings`)[0]?.body).toEqual({
      trialDays: 30,
      graceDays: 3,
      purchasesOpen: true,
      reason: 'Longer trial.',
    });
  });

  it('withdraws the scheduled price', async () => {
    const api = server().on('POST', `${OFFER_URL}/prices/${SCHEDULED_ID}/withdraw`, {
      status: 200,
      body: offer({ scheduled: { monthly: null, yearly: null } }),
    });
    const { user } = renderApp('/subscription');

    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Entered too early.');
    await user.click(dialog.getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls('POST', `${OFFER_URL}/prices/${SCHEDULED_ID}/withdraw`)[0]?.body).toEqual({
      reason: 'Entered too early.',
    });
  });

  it('is read-only without subscriptions.manage', async () => {
    server(
      adminMe({
        roles: ['moderator'],
        permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'subscriptions.manage'),
      }),
    );
    renderApp('/subscription');

    expect((await screen.findAllByText(money(2_000))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Change prices' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('says so when the server refuses the read', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', OFFER_URL, apiError(403, 'FORBIDDEN'));
    renderApp('/subscription');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not allow this change.',
    );
  });
});
