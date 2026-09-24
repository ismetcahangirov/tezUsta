import type { AdminAuditEntry } from '@tezusta/types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const ACTOR = adminMe().id;
const SERVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const UPDATE: AdminAuditEntry = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  action: 'catalogue.service.update',
  targetType: 'service',
  targetId: SERVICE,
  reason: null,
  before: { basePriceMinor: 4550, isActive: true },
  after: { basePriceMinor: 1999, isActive: false },
  createdAt: '2026-09-23T10:00:00.000Z',
  actor: { id: ACTOR, email: 'aysel@tezusta.test', displayName: 'Aysel Mammadova' },
};

const READ: AdminAuditEntry = {
  id: 'cccccccc-0000-4000-8000-000000000002',
  action: 'order.read',
  targetType: 'order',
  targetId: '66666666-6666-4666-8666-666666666666',
  reason: 'Customer called about a no-show',
  before: null,
  after: null,
  createdAt: '2026-09-23T09:00:00.000Z',
  actor: { id: ACTOR, email: 'aysel@tezusta.test', displayName: 'Aysel Mammadova' },
};

function auditServer() {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
    .on('GET', '/api/admin/audit-log', (request) =>
      request.search.get('cursor') === 'next'
        ? { status: 200, body: { items: [READ], nextCursor: null } }
        : { status: 200, body: { items: [UPDATE], nextCursor: 'next' } },
    );
}

async function openAudit() {
  const server = auditServer();
  const rendered = renderApp('/audit');
  await screen.findByRole('table', { name: 'Audit log' });
  return { server, ...rendered };
}

describe('audit log', () => {
  it('sends the filters it is given', async () => {
    const { server, user } = await openAudit();

    await user.type(screen.getByLabelText('Admin id'), ACTOR);
    await user.type(screen.getByLabelText('Action (prefix)'), 'catalogue');
    await user.type(screen.getByLabelText('Target type'), 'service');
    await user.type(screen.getByLabelText('Target id'), SERVICE);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-20T08:30' } });
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/audit-log')).toHaveLength(2);
    });
    const search = server.calls('GET', '/api/admin/audit-log')[1]?.search;
    expect(search?.get('actorId')).toBe(ACTOR);
    expect(search?.get('action')).toBe('catalogue');
    expect(search?.get('targetType')).toBe('service');
    expect(search?.get('targetId')).toBe(SERVICE);
    // The local time the admin picked, as the instant it is.
    expect(search?.get('from')).toBe(new Date('2026-09-20T08:30').toISOString());
    expect(search?.has('to')).toBe(false);
  });

  it('refuses a target id without its type, and a malformed action, before calling the API', async () => {
    const { server, user } = await openAudit();

    await user.type(screen.getByLabelText('Target id'), SERVICE);
    await user.type(screen.getByLabelText('Action (prefix)'), 'Catalogue!');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(screen.getByLabelText('Target type')).toHaveAccessibleDescription(
      'A target id needs its target type.',
    );
    expect(screen.getByLabelText('Action (prefix)')).toHaveAccessibleDescription(
      'Lower-case words separated by dots.',
    );
    expect(server.calls('GET', '/api/admin/audit-log')).toHaveLength(1);
  });

  it('expands a row into a readable before/after of each changed field', async () => {
    const { user } = await openAudit();

    const toggle = screen.getByRole('button', {
      name: 'Show changes for catalogue.service.update',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    const diff = screen.getByRole('table', { name: 'Changes made by catalogue.service.update' });
    const lines = within(diff)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
    expect(lines).toEqual([
      ['basePriceMinor', '4550', '1999'],
      ['isActive', 'true', 'false'],
    ]);

    await user.click(
      screen.getByRole('button', { name: 'Hide changes for catalogue.service.update' }),
    );
    expect(
      screen.queryByRole('table', { name: 'Changes made by catalogue.service.update' }),
    ).not.toBeInTheDocument();
  });

  it('loads older entries with the cursor, and says a read changed nothing', async () => {
    const { server, user } = await openAudit();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('order.read');
    expect(server.calls('GET', '/api/admin/audit-log')[1]?.search.get('cursor')).toBe('next');
    expect(screen.getByText('Customer called about a no-show')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show changes for order.read' }));
    expect(screen.getByText('Nothing changed — this entry records a read.')).toBeInTheDocument();
  });
});
