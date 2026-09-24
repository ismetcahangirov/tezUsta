import type { AdminReview } from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const MASTER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';

function review(overrides: Partial<AdminReview> & { id: string }): AdminReview {
  return {
    orderId: '66666666-6666-4666-8666-666666666666',
    authorRole: 'customer',
    rating: 2,
    comment: 'Gec gəldi <b>bold</b>',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    revealedAt: '2026-09-21T10:00:00.000Z',
    removedAt: null,
    customerId: CUSTOMER,
    masterId: MASTER,
    removedByAdminId: null,
    removalReason: null,
    ...overrides,
  };
}

const FIRST = review({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
const SECOND = review({
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  rating: 1,
  comment: 'Spam',
  removedAt: '2026-09-22T10:00:00.000Z',
  removedByAdminId: adminMe().id,
  removalReason: 'Advertising',
});
const THIRD = review({ id: 'aaaaaaaa-0000-4000-8000-000000000003', comment: null, rating: 5 });

function reviewsServer() {
  return installFakeServer()
    .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
    .on('GET', '/api/admin/reviews', (request) =>
      request.search.get('cursor') === 'page-2'
        ? { status: 200, body: { items: [THIRD], nextCursor: null } }
        : { status: 200, body: { items: [FIRST, SECOND], nextCursor: 'page-2' } },
    );
}

async function openReviews(server = reviewsServer()) {
  const rendered = renderApp('/reviews');
  await screen.findByRole('table', { name: 'Reviews' });
  return { server, ...rendered };
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('table', { name: 'Reviews' }))
    .getAllByRole('row')
    .slice(1);
}

describe('review moderation', () => {
  it('lists reviews with removed ones marked, and renders a comment as text', async () => {
    await openReviews();

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveTextContent('Gec gəldi <b>bold</b>');
    expect(rows()[0]?.querySelector('b')).toBeNull();
    expect(rows()[0]).toHaveTextContent('Visible');
    expect(rows()[1]).toHaveTextContent('Removed');
    expect(rows()[1]).toHaveTextContent('Reason: Advertising');
    expect(within(rows()[1] as HTMLElement).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('pages on with the cursor the server gave', async () => {
    const { server, user } = await openReviews();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(server.calls('GET', '/api/admin/reviews')[1]?.search.get('cursor')).toBe('page-2');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('sends the filters the API supports and refuses one that is not an id', async () => {
    const { server, user } = await openReviews();

    await user.type(screen.getByLabelText('Master id'), 'not-an-id');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByLabelText('Master id')).toHaveAccessibleDescription(
      'Paste a full id (a UUID).',
    );
    expect(server.calls('GET', '/api/admin/reviews')).toHaveLength(1);

    await user.clear(screen.getByLabelText('Master id'));
    await user.type(screen.getByLabelText('Master id'), MASTER);
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/reviews')).toHaveLength(2);
    });
    const search = server.calls('GET', '/api/admin/reviews')[1]?.search;
    expect(search?.get('masterId')).toBe(MASTER);
    expect(search?.has('customerId')).toBe(false);
    expect(search?.has('cursor')).toBe(false);
  });

  it('will not remove a review without a reason, then removes it with one', async () => {
    const path = `/api/admin/reviews/${FIRST.id}/removal`;
    const { server, user } = await openReviews(
      reviewsServer().on('POST', path, {
        status: 200,
        body: { ...FIRST, removedAt: '2026-09-24T10:00:00.000Z' },
      }),
    );

    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this review' });
    await user.type(within(dialog).getByLabelText('Reason'), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Remove review' }));

    expect(within(dialog).getByText('Give a reason for the removal.')).toBeInTheDocument();
    expect(server.calls('POST', path)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason'), 'Insults the master');
    await user.click(within(dialog).getByRole('button', { name: 'Remove review' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(server.calls('POST', path)[0]?.body).toEqual({ reason: 'Insults the master' });
    // The removal invalidated the list, so it was read again.
    await waitFor(() => {
      expect(server.calls('GET', '/api/admin/reviews').length).toBeGreaterThan(1);
    });
  });

  it('keeps the dialog open and says so when a removal fails', async () => {
    const { user } = await openReviews(
      reviewsServer().on(
        'POST',
        `/api/admin/reviews/${FIRST.id}/removal`,
        apiError(500, 'INTERNAL_ERROR'),
      ),
    );

    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this review' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Insults the master');
    await user.click(within(dialog).getByRole('button', { name: 'Remove review' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The review was not removed. Try again.',
    );
  });

  it('recalculates ratings only after a confirmation, and reports what it corrected', async () => {
    const { server, user } = await openReviews(
      reviewsServer().on('POST', '/api/admin/ratings/recalculate', {
        status: 200,
        body: { scope: 'master', mastersCorrected: 1, customersCorrected: 0 },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Recalculate ratings' }));
    const dialog = screen.getByRole('dialog', { name: 'Recalculate ratings' });
    expect(server.calls('POST', '/api/admin/ratings/recalculate')).toHaveLength(0);

    await user.selectOptions(within(dialog).getByLabelText('Whose ratings'), 'master');
    await user.type(within(dialog).getByLabelText('Id'), MASTER);
    await user.click(within(dialog).getByRole('button', { name: 'Recalculate' }));

    expect(
      await within(dialog).findByText('Done. Corrected 1 master and 0 customer ratings.'),
    ).toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/ratings/recalculate')[0]?.body).toEqual({
      masterId: MASTER,
    });
  });

  it('cancelling the confirmation recalculates nothing', async () => {
    const { server, user } = await openReviews();

    await user.click(screen.getByRole('button', { name: 'Recalculate ratings' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(server.calls('POST', '/api/admin/ratings/recalculate')).toHaveLength(0);
  });
});
