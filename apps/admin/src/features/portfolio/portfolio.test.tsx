import type {
  AdminMasterDetail,
  AdminPortfolioPost,
  AdminPortfolioPostDetail,
} from '@tezusta/types';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { adminMe, apiError, installFakeServer } from '../../../test/fake-server';
import { renderApp } from '../../../test/render-app';

const MASTER_ID = '44444444-4444-4444-8444-444444444444';
const POST_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function post(overrides: Partial<AdminPortfolioPost> = {}): AdminPortfolioPost {
  return {
    id: POST_ID,
    masterId: MASTER_ID,
    masterName: 'Usta Rəşad',
    masterStatus: 'active',
    status: 'published',
    caption: 'Hamam kranı <b>yeni</b>',
    mediaCount: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    publishedAt: '2026-10-01T10:05:00.000Z',
    removedAt: null,
    removedByAdminId: null,
    removalReason: null,
    evidence: 'none',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminPortfolioPostDetail> = {}): AdminPortfolioPostDetail {
  return {
    ...post(),
    media: [
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        position: 0,
        status: 'ready',
        thumbUrl: 'https://media.example.com/portfolio/a/thumb.webp',
        displayUrl: 'https://media.example.com/portfolio/a/display.webp',
        width: 1440,
        height: 1080,
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        position: 1,
        status: 'ready',
        thumbUrl: 'https://media.example.com/portfolio/b/thumb.webp',
        displayUrl: 'https://media.example.com/portfolio/b/display.webp',
        width: 1080,
        height: 1440,
      },
    ],
    ...overrides,
  };
}

const LIST = '/api/admin/portfolio/posts';
const DETAIL = `/api/admin/portfolio/posts/${POST_ID}`;

describe('portfolio moderation (#312)', () => {
  it('lists posts with their master and status, and renders a caption as text', async () => {
    const removed = post({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      removedAt: '2026-10-02T10:00:00.000Z',
      removalReason: 'Ev nömrəsi',
      evidence: 'kept',
    });
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, { status: 200, body: { items: [post(), removed], nextCursor: null } });

    renderApp('/portfolio');

    const table = await screen.findByRole('table', { name: 'Portfolio posts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Usta Rəşad');
    expect(rows[0]).toHaveTextContent('Published');
    expect(rows[0]).toHaveTextContent('Hamam kranı <b>yeni</b>');
    expect(rows[0]?.querySelector('b')).toBeNull();
    expect(rows[1]).toHaveTextContent('Removed');
  });

  it('filters by the master a file linked from, and by status', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, { status: 200, body: { items: [post()], nextCursor: null } });

    const { user } = renderApp(`/portfolio?masterId=${MASTER_ID}`);
    await screen.findByRole('table', { name: 'Portfolio posts' });
    expect(server.calls('GET', LIST)[0]?.search.get('masterId')).toBe(MASTER_ID);

    await user.selectOptions(screen.getByLabelText('Status'), 'removed');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => {
      expect(server.calls('GET', LIST).at(-1)?.search.get('status')).toBe('removed');
    });
    expect(server.calls('GET', LIST).at(-1)?.search.get('masterId')).toBe(MASTER_ID);
  });

  it('refuses a master id that is not a uuid before asking the server', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', LIST, { status: 200, body: { items: [], nextCursor: null } });
    const { user } = renderApp('/portfolio');
    await screen.findByText('No posts match these filters.');

    await user.type(screen.getByLabelText('Master id'), 'rashad');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('Paste a full id (a UUID).')).toBeInTheDocument();
    expect(server.calls('GET', LIST)).toHaveLength(1);
  });

  it('shows a post’s photos and removes it with a reason', async () => {
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/removal`, {
        status: 200,
        body: detail({
          removedAt: '2026-10-03T10:00:00.000Z',
          removalReason: 'Ev nömrəsi',
          evidence: 'kept',
        }),
      });

    const { user } = renderApp(`/portfolio/${POST_ID}`);

    expect(await screen.findByRole('img', { name: 'Photo 1' })).toHaveAttribute(
      'src',
      'https://media.example.com/portfolio/a/thumb.webp',
    );
    expect(screen.getByRole('img', { name: 'Photo 2' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usta Rəşad' })).toHaveAttribute(
      'href',
      `/masters/${MASTER_ID}`,
    );

    await user.click(screen.getByRole('button', { name: 'Remove post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this post' });
    // No reason: refused before the request.
    await user.click(within(dialog).getByRole('button', { name: 'Remove post' }));
    expect(await within(dialog).findByText('Give a reason for the removal.')).toBeInTheDocument();
    expect(server.calls('POST', `${DETAIL}/removal`)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Reason'), '  Ev nömrəsi  ');
    await user.click(within(dialog).getByRole('button', { name: 'Remove post' }));

    await waitFor(() => {
      expect(server.calls('POST', `${DETAIL}/removal`)).toHaveLength(1);
    });
    expect(server.calls('POST', `${DETAIL}/removal`)[0]?.body).toEqual({ reason: 'Ev nömrəsi' });
    expect(await screen.findByText('The post was removed.')).toBeInTheDocument();
  });

  it('shows a removed post’s reason and evidence state, with no remove action', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, {
        status: 200,
        body: detail({
          removedAt: '2026-10-03T10:00:00.000Z',
          removalReason: 'Ev nömrəsi görünür',
          evidence: 'purged',
          media: [],
        }),
      });

    renderApp(`/portfolio/${POST_ID}`);

    expect(await screen.findByText('Ev nömrəsi görünür')).toBeInTheDocument();
    expect(screen.getByText('Photos deleted after the retention window')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove post' })).toBeNull();
    expect(screen.getByText('No photos to show.')).toBeInTheDocument();
  });

  it('says so when the server refuses the removal', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: detail() })
      .on('POST', `${DETAIL}/removal`, apiError(500, 'INTERNAL_ERROR'));
    const { user } = renderApp(`/portfolio/${POST_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Remove post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this post' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Qayda');
    await user.click(within(dialog).getByRole('button', { name: 'Remove post' }));

    expect(
      await within(dialog).findByText('The post was not removed. Try again.'),
    ).toBeInTheDocument();
  });

  it('treats a post another admin removed first as done, and shows their removal', async () => {
    installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on(
        'GET',
        DETAIL,
        { status: 200, body: detail() },
        {
          status: 200,
          body: detail({
            removedAt: '2026-10-03T10:00:00.000Z',
            removalReason: 'Birinci admin',
            evidence: 'pending_move',
          }),
        },
      )
      .on('POST', `${DETAIL}/removal`, apiError(409, 'PORTFOLIO_POST_ALREADY_REMOVED'));
    const { user } = renderApp(`/portfolio/${POST_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Remove post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this post' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Qayda');
    await user.click(within(dialog).getByRole('button', { name: 'Remove post' }));

    expect(
      await screen.findByText('Another admin had already removed this post.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Birinci admin')).toBeInTheDocument();
  });

  it('opens kept evidence through a freshly minted URL, not the one the page loaded with', async () => {
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const removed = (sig: string) =>
      detail({
        removedAt: '2026-10-03T10:00:00.000Z',
        removalReason: 'Ev nömrəsi',
        evidence: 'kept',
        media: [
          {
            id: 'bbbbbbbb-0000-4000-8000-000000000001',
            position: 0,
            status: 'ready',
            thumbUrl: `https://storage.test/thumb?sig=${sig}`,
            displayUrl: `https://storage.test/display?sig=${sig}`,
            width: 1440,
            height: 1080,
          },
        ],
      });
    const server = installFakeServer()
      .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
      .on('GET', DETAIL, { status: 200, body: removed('1') }, { status: 200, body: removed('2') });
    const { user } = renderApp(`/portfolio/${POST_ID}`);

    await user.click(await screen.findByRole('img', { name: 'Photo 1' }));

    await waitFor(() => {
      expect(tab.location.href).toBe('https://storage.test/display?sig=2');
    });
    expect(tab.opener).toBeNull();
    expect(server.calls('GET', DETAIL)).toHaveLength(2);
  });

  it('is hidden from an admin without portfolio.moderate', async () => {
    installFakeServer().on('GET', '/api/admin/me', {
      status: 200,
      body: adminMe({ roles: ['support'], permissions: ['dashboard.read', 'masters.read'] }),
    });

    renderApp('/portfolio');

    expect(await screen.findByRole('navigation')).not.toHaveTextContent('Portfolio');
  });

  describe('a master’s avatar, from their file', () => {
    function masterDetail(avatarUrl: string | null): AdminMasterDetail {
      return {
        id: MASTER_ID,
        displayName: 'Usta Rəşad',
        verificationStatus: 'active',
        suspendedAt: null,
        isAvailable: false,
        ratingCount: 0,
        createdAt: '2026-09-20T09:00:00.000Z',
        subscriptionStatus: null,
        bio: null,
        avatarUrl,
        services: [],
        documents: [],
        history: [],
      };
    }

    it('shows the avatar, links to the master’s posts, and removes it with a reason', async () => {
      const server = installFakeServer()
        .on('GET', '/api/admin/me', { status: 200, body: adminMe() })
        .on(
          'GET',
          `/api/admin/masters/${MASTER_ID}`,
          { status: 200, body: masterDetail('https://media.example.com/avatars/x/display.webp') },
          { status: 200, body: masterDetail(null) },
        )
        .on('GET', `/api/admin/masters/${MASTER_ID}/subscription`, {
          status: 200,
          body: { subscription: null, events: [] },
        })
        .on('POST', `/api/admin/masters/${MASTER_ID}/avatar/removal`, { status: 204 });

      const { user } = renderApp(`/masters/${MASTER_ID}`);

      expect(await screen.findByRole('img', { name: "Usta Rəşad's avatar" })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Portfolio posts' })).toHaveAttribute(
        'href',
        `/portfolio?masterId=${MASTER_ID}`,
      );

      await user.click(screen.getByRole('button', { name: 'Remove avatar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Remove this avatar' });
      await user.type(within(dialog).getByLabelText('Reason'), 'Başqasının şəkli');
      await user.click(within(dialog).getByRole('button', { name: 'Remove avatar' }));

      await waitFor(() => {
        expect(server.calls('POST', `/api/admin/masters/${MASTER_ID}/avatar/removal`)).toHaveLength(
          1,
        );
      });
      expect(
        server.calls('POST', `/api/admin/masters/${MASTER_ID}/avatar/removal`)[0]?.body,
      ).toEqual({
        reason: 'Başqasının şəkli',
      });
      expect(await screen.findByText('The avatar was removed.')).toBeInTheDocument();
      expect(await screen.findByText('No avatar.')).toBeInTheDocument();
    });
  });
});
