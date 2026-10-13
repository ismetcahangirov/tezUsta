import type { AdminPermission, AdminReportDetail, AdminReportSummary } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const REPORT_ID = '5d1e2f3a-0000-4000-8000-000000000001';
const LIST = '/api/admin/reports';
const DETAIL = `${LIST}/${REPORT_ID}`;

function summary(overrides: Partial<AdminReportSummary> = {}): AdminReportSummary {
  return {
    id: REPORT_ID,
    orderId: '3f2a9c1e-0000-4000-8000-000000000001',
    reasonCode: 'asked_off_platform_payment',
    status: 'open',
    reporter: {
      role: 'customer',
      profileId: '0b9e7d1c-0000-4000-8000-000000000001',
      displayName: 'Leyla Hasanova',
    },
    reported: {
      role: 'master',
      profileId: '0b9e7d1c-0000-4000-8000-0000000000aa',
      displayName: 'Rashad Aliyev',
    },
    createdAt: '2026-10-10T09:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminReportDetail> = {}): AdminReportDetail {
  return {
    ...summary(),
    text: '<b>Asked for cash</b> and left.',
    order: {
      id: '3f2a9c1e-0000-4000-8000-000000000001',
      status: 'COMPLETED',
      serviceName: 'Santexnik',
      createdAt: '2026-10-09T09:00:00.000Z',
    },
    handledBy: null,
    claimedAt: null,
    closedAt: null,
    outcome: null,
    outcomeReason: null,
    reportsAboutReportedLast30Days: 3,
    ...overrides,
  };
}

function me(permissions?: readonly AdminPermission[]) {
  return {
    status: 200,
    body: permissions === undefined ? adminMe() : adminMe({ roles: ['support'], permissions }),
  };
}

describe('report queue (#330)', () => {
  it('lists the open queue by default, with both parties and a link to each report', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, { status: 200, body: { items: [summary()], nextCursor: null } });
    renderApp('/reports');

    const table = await screen.findByRole('table', { name: 'Reports, oldest first' });
    expect(within(table).getByText('Asked to pay outside the app')).toBeInTheDocument();
    expect(within(table).getByText('Leyla Hasanova')).toBeInTheDocument();
    expect(within(table).getByText('Rashad Aliyev')).toBeInTheDocument();
    expect(
      within(table).getByRole('link', {
        name: 'Open: Asked to pay outside the app, Rashad Aliyev',
      }),
    ).toHaveAttribute('href', `/reports/${REPORT_ID}`);
    expect(server.calls('GET', LIST)[0]?.search.get('status')).toBe('open');
  });

  it('sends the reason filter and keeps it in the URL', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', LIST, { status: 200, body: { items: [], nextCursor: null } });
    const { user } = renderApp('/reports');
    await screen.findByText('No reports match this filter.');

    await user.selectOptions(screen.getByLabelText('Reason'), 'damage');
    await waitFor(() => {
      expect(server.calls('GET', LIST).at(-1)?.search.get('reason')).toBe('damage');
    });
    expect(window.location.search).toContain('reason=damage');
  });
});

describe('one report (#330)', () => {
  it('shows what was written as text, never as markup, with the parties and the repeat count', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/reports/${REPORT_ID}`);

    expect(await screen.findByText('<b>Asked for cash</b> and left.')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: 'Rashad Aliyev' })).toHaveAttribute(
      'href',
      '/masters/0b9e7d1c-0000-4000-8000-0000000000aa',
    );
    expect(
      screen.getByText('3 reports about them in the last 30 days, this one included.'),
    ).toBeInTheDocument();
  });

  it('claims an open report', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/claim`, { status: 204 });
    const { user } = renderApp(`/reports/${REPORT_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(() => {
      expect(server.calls('POST', `${DETAIL}/claim`)).toHaveLength(1);
    });
  });

  it('closes a report in review with an outcome and a reason, and explains a refused suspension', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', me())
      .on('GET', DETAIL, {
        status: 200,
        body: detail({ status: 'in_review', handledBy: { id: 'a1', displayName: 'Nigar' } }),
      })
      .on('POST', `${DETAIL}/close`, apiError(409, 'REPORT_OUTCOME_NOT_TAKEN'), {
        status: 204,
      });
    const { user } = renderApp(`/reports/${REPORT_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Close with an outcome' }));
    const dialog = screen.getByRole('dialog', { name: 'Close this report' });
    await user.click(within(dialog).getByRole('button', { name: 'Close report' }));
    expect(within(dialog).getByText('Write a reason.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/close`)).toHaveLength(0);

    await user.selectOptions(within(dialog).getByLabelText('Outcome'), 'master_suspended');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Nağd istəyirdi.');
    await user.click(within(dialog).getByRole('button', { name: 'Close report' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That suspension is not on the reported person’s account.',
    );

    await user.selectOptions(within(dialog).getByLabelText('Outcome'), 'warning_recorded');
    await user.click(within(dialog).getByRole('button', { name: 'Close report' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(server.calls('POST', `${DETAIL}/close`).at(-1)?.body).toEqual({
      outcome: 'warning_recorded',
      reason: 'Nağd istəyirdi.',
    });
  });

  it('shows no actions to a role that may only read', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', me(['reports.read']))
      .on('GET', DETAIL, { status: 200, body: detail() });
    renderApp(`/reports/${REPORT_ID}`);

    expect(await screen.findByText('<b>Asked for cash</b> and left.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument();
    // Without masters.read the name is not a link.
    expect(screen.queryByRole('link', { name: 'Rashad Aliyev' })).not.toBeInTheDocument();
  });
});
