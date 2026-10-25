import type { Master, OwnPortfolioPost } from '@tezusta/types';
import { fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { OwnProfile, PORTFOLIO_MAX_POSTS } from './OwnProfile';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PROFILE } from './portfolio-fixtures';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));

const MASTER_ID = 'master-1';

function master(overrides: Partial<Master> = {}): Master {
  return {
    id: MASTER_ID,
    displayName: PROFILE.displayName,
    bio: PROFILE.bio,
    verificationStatus: 'active',
    avatarUrl: null,
    avatarLargeUrl: null,
    ...overrides,
  } as Master;
}

function post(
  id: string,
  status: OwnPortfolioPost['status'],
  caption: string | null = null,
): OwnPortfolioPost {
  const ready = status === 'published';
  return {
    id,
    status,
    caption,
    service: null,
    media: [
      {
        id: `${id}-m`,
        position: 0,
        status: ready ? 'ready' : status === 'failed' ? 'failed' : 'processing',
        failureCode: status === 'failed' ? 'undecodable' : null,
        thumbUrl: ready ? `https://media.example.com/${id}-thumb.webp` : null,
        displayUrl: ready ? `https://media.example.com/${id}-display.webp` : null,
        width: ready ? 1440 : null,
        height: ready ? 1080 : null,
      },
    ],
    failureCode: status === 'failed' ? 'undecodable' : null,
    removedAt: null,
    createdAt: '2026-10-16T08:00:00.000Z',
    publishedAt: ready ? '2026-10-16T08:01:00.000Z' : null,
  };
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

let replies: Record<string, Reply> = {};
let calls: { method: string; path: string; body: unknown }[] = [];

function key(method: string, path: string): string {
  return `${method} ${path}`;
}

function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const text =
      request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });
    const reply = replies[key(request.method, url.pathname)] ?? { status: 404, body: {} };
    return reply.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as typeof fetch;
}

function withPosts(posts: OwnPortfolioPost[]): void {
  replies[key('GET', '/masters/me/portfolio/posts')] = { body: { items: posts, nextCursor: null } };
}

async function mount(): Promise<{ onNewPost: jest.Mock; onManageServices: jest.Mock }> {
  const onNewPost = jest.fn();
  const onManageServices = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <OwnProfile
        focused={false}
        onBack={jest.fn()}
        onNewPost={onNewPost}
        onManageServices={onManageServices}
      />
    </Provider>,
  );
  return { onNewPost, onManageServices };
}

beforeEach(() => {
  calls = [];
  replies = {
    [key('GET', '/masters/me')]: { body: master() },
    [key('GET', `/masters/${MASTER_ID}/profile`)]: {
      body: { ...PROFILE, masterId: MASTER_ID, posts: [], nextCursor: null },
    },
  };
  installTransport();
});

describe('OwnProfile', () => {
  it('tells a master who is not active why they cannot post', async () => {
    replies[key('GET', '/masters/me')] = {
      body: master({ verificationStatus: 'pending_verification' }),
    };
    await mount();

    expect(await screen.findByText(copy.own.notActive)).toBeOnTheScreen();
    expect(calls.some((call) => call.path.endsWith('/profile'))).toBe(false);
  });

  it('shows the master’s own profile with every post, marked by its state', async () => {
    withPosts([post('p1', 'processing'), post('p2', 'failed'), post('p3', 'published', 'Kran')]);
    await mount();

    expect(await screen.findByRole('header', { name: copy.own.title })).toBeOnTheScreen();
    expect(await screen.findByText(copy.grid.processing)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.grid.failed })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: `${copy.grid.tile(1)}. Kran` })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.own.newPost })).toBeEnabled();
    expect(screen.getByRole('button', { name: copy.avatar.change })).toBeOnTheScreen();
  });

  it('carries "Yeni paylaşım" in the empty state when there is nothing yet', async () => {
    withPosts([]);
    const { onNewPost } = await mount();

    expect(await screen.findByText(copy.own.emptyTitle)).toBeOnTheScreen();
    const buttons = screen.getAllByRole('button', { name: copy.own.newPost });
    expect(buttons).toHaveLength(1);

    await userEvent.press(buttons[0]!);
    expect(onNewPost).toHaveBeenCalled();
  });

  it('disables "Yeni paylaşım" at the post limit and says why', async () => {
    withPosts(
      Array.from({ length: PORTFOLIO_MAX_POSTS }, (_, i) => post(`p${String(i)}`, 'published')),
    );
    await mount();

    expect(await screen.findByText(copy.own.postLimit(PORTFOLIO_MAX_POSTS))).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.own.newPost })).toBeDisabled();
  });

  it('removes a deleted post at once, from a failed tile', async () => {
    withPosts([post('p1', 'failed'), post('p2', 'published', 'Kran')]);
    replies[key('DELETE', '/masters/me/portfolio/posts/p1')] = { status: 204 };
    await mount();

    await userEvent.press(await screen.findByRole('button', { name: copy.grid.failed }));
    expect(screen.getByText(copy.manage.deleteTitle)).toBeOnTheScreen();
    // The list re-read after the delete no longer has it.
    withPosts([post('p2', 'published', 'Kran')]);
    await userEvent.press(screen.getByRole('button', { name: copy.manage.delete }));

    expect(screen.queryByRole('button', { name: copy.grid.failed })).not.toBeOnTheScreen();
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: '/masters/me/portfolio/posts/p1',
        body: undefined,
      });
    });
    expect(screen.queryByText(copy.manage.deleteFailed)).not.toBeOnTheScreen();
  });

  it('puts the post back and says so when the server refuses the delete', async () => {
    withPosts([post('p1', 'failed')]);
    replies[key('DELETE', '/masters/me/portfolio/posts/p1')] = {
      status: 409,
      body: { code: 'PORTFOLIO_POST_NOT_EDITABLE' },
    };
    await mount();

    await userEvent.press(await screen.findByRole('button', { name: copy.grid.failed }));
    await userEvent.press(screen.getByRole('button', { name: copy.manage.delete }));

    expect(await screen.findByText(copy.manage.deleteFailed)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.grid.failed })).toBeOnTheScreen();
  });

  it('edits a published post’s caption from the viewer', async () => {
    withPosts([post('p1', 'published', 'Kran')]);
    replies[key('PATCH', '/masters/me/portfolio/posts/p1')] = {
      body: post('p1', 'published', 'Yeni'),
    };
    await mount();

    await userEvent.press(
      await screen.findByRole('button', { name: `${copy.grid.tile(1)}. Kran` }),
    );
    await userEvent.press(screen.getByRole('button', { name: copy.viewer.edit }));
    await fireEvent.changeText(screen.getByLabelText(copy.editor.caption), 'Yeni');
    await userEvent.press(screen.getByRole('button', { name: copy.manage.save }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: '/masters/me/portfolio/posts/p1',
        body: { caption: 'Yeni' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: copy.manage.save })).not.toBeOnTheScreen();
    });
  });

  it('offers the avatar’s choices, and removal only when there is one to remove', async () => {
    withPosts([]);
    await mount();

    await userEvent.press(await screen.findByRole('button', { name: copy.avatar.change }));

    expect(screen.getByRole('button', { name: copy.avatar.pick })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.avatar.remove })).not.toBeOnTheScreen();
    // The scrim dismisses too, under the same name; the sheet's own button is the last.
    const cancels = screen.getAllByRole('button', { name: copy.avatar.cancel });
    await userEvent.press(cancels[cancels.length - 1]!);
    expect(screen.queryByRole('button', { name: copy.avatar.pick })).not.toBeOnTheScreen();
  });

  it('offers a retry when the posts could not be read', async () => {
    replies[key('GET', '/masters/me/portfolio/posts')] = {
      status: 500,
      body: { code: 'INTERNAL' },
    };
    await mount();

    const retry = await screen.findByRole(
      'button',
      { name: copy.profile.retry },
      { timeout: 10_000 },
    );
    expect(screen.getByText(copy.profile.errorTitle)).toBeOnTheScreen();

    withPosts([post('p1', 'published', 'Kran')]);
    await userEvent.press(retry);

    expect(
      await screen.findByRole(
        'button',
        { name: `${copy.grid.tile(1)}. Kran` },
        { timeout: 10_000 },
      ),
    ).toBeOnTheScreen();
  }, 30_000);

  it('deletes a post from the viewer, closing it', async () => {
    withPosts([post('p1', 'published', 'Kran')]);
    replies[key('DELETE', '/masters/me/portfolio/posts/p1')] = { status: 204 };
    await mount();

    await userEvent.press(
      await screen.findByRole('button', { name: `${copy.grid.tile(1)}. Kran` }),
    );
    withPosts([]);
    await userEvent.press(screen.getByRole('button', { name: copy.viewer.delete }));
    // The viewer's own "Sil" and the sheet's share a name; the sheet's is drawn last.
    const deletes = screen.getAllByRole('button', { name: copy.manage.delete });
    await userEvent.press(deletes[deletes.length - 1]!);

    expect(screen.queryByRole('button', { name: copy.viewer.close })).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: `${copy.grid.tile(1)}. Kran` }),
    ).not.toBeOnTheScreen();
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: '/masters/me/portfolio/posts/p1',
        body: undefined,
      });
    });
  });

  describe('the way to the services screen (ADR-0063)', () => {
    it('sits at the foot of the Services card', async () => {
      withPosts([]);
      const { onManageServices } = await mount();

      await fireEvent.press(await screen.findByRole('button', { name: copy.own.manageServices }));

      expect(onManageServices).toHaveBeenCalledTimes(1);
      expect(screen.getByText(PROFILE.services[0]!.name)).toBeOnTheScreen();
    });

    it.each(['pending_verification', 'changes_requested'] as const)(
      'is offered to a master whose status is %s (ADR-0064)',
      async (verificationStatus) => {
        replies[key('GET', '/masters/me')] = { body: master({ verificationStatus }) };
        const { onManageServices } = await mount();

        expect(await screen.findByText(copy.own.notActive)).toBeOnTheScreen();
        await fireEvent.press(screen.getByRole('button', { name: copy.own.manageServices }));

        expect(onManageServices).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['rejected', 'suspended'] as const)(
      'is not offered to a master whose status is %s',
      async (verificationStatus) => {
        replies[key('GET', '/masters/me')] = { body: master({ verificationStatus }) };
        await mount();

        expect(await screen.findByText(copy.own.notActive)).toBeOnTheScreen();
        expect(
          screen.queryByRole('button', { name: copy.own.manageServices }),
        ).not.toBeOnTheScreen();
      },
    );

    it('keeps the card, saying so, before a first service', async () => {
      withPosts([]);
      replies[key('GET', `/masters/${MASTER_ID}/profile`)] = {
        body: { ...PROFILE, masterId: MASTER_ID, services: [], posts: [], nextCursor: null },
      };
      await mount();

      expect(await screen.findByText(copy.own.noServices)).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: copy.own.manageServices })).toBeOnTheScreen();
    });
  });
});
