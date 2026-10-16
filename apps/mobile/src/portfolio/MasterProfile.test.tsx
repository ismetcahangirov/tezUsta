import type { MasterPublicProfile, Order, PortfolioPost } from '@tezusta/types';
import { fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { StatusBar } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { PORTFOLIO_PAGE_SIZE } from './master-profile-endpoints';
import { MasterProfile } from './MasterProfile';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { media, PROFILE } from './portfolio-fixtures';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

const ORDER_ID = 'order-1';
const MASTER_ID = 'master-1';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    status: 'ACCEPTED',
    serviceId: 'svc-1',
    addressId: 'addr-1',
    description: 'Mətbəxdə kran sızır.',
    priceMinor: 2500,
    masterId: MASTER_ID,
    redispatchCount: 0,
    acceptedAt: '2026-10-16T08:00:00.000Z',
    createdAt: '2026-10-16T07:00:00.000Z',
    updatedAt: '2026-10-16T08:00:00.000Z',
    ...overrides,
  };
}

function posts(from: number, count: number): PortfolioPost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `post-${String(from + i)}`,
    caption: `İş ${String(from + i)}`,
    service: null,
    media: [media(`m-${String(from + i)}`)],
  }));
}

function profile(overrides: Partial<MasterPublicProfile> = {}): MasterPublicProfile {
  return { ...PROFILE, masterId: MASTER_ID, posts: posts(1, 2), nextCursor: null, ...overrides };
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

/** Keyed by path and query string, e.g. `/masters/master-1/portfolio?cursor=c1&limit=30`. */
let replies: Record<string, Reply> = {};
let requested: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const query = url.searchParams.toString();
    const key = query === '' ? url.pathname : `${url.pathname}?${query}`;
    requested.push(key);

    const reply = replies[key] ?? (key === `/orders/${ORDER_ID}` ? { body: order() } : {});
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(): Promise<{ onBack: jest.Mock }> {
  installTransport();
  const onBack = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <MasterProfile orderId={ORDER_ID} onBack={onBack} />
    </Provider>,
  );
  return { onBack };
}

/**
 * The grid laid out and scrolled to its end, as a reader reaching the last row
 * does. Each further page makes the content taller, so a second call passes a
 * larger `contentHeight`: the list fires its end once per content length.
 */
async function scrollToEnd(contentHeight = 1000): Promise<void> {
  const list = screen.getByTestId('media-grid');
  await fireEvent(list, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 100 } },
  });
  await fireEvent(list, 'contentSizeChange', 360, contentHeight);
  await fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { x: 0, y: contentHeight - 100 },
      contentSize: { width: 360, height: contentHeight },
      layoutMeasurement: { width: 360, height: 100 },
    },
  });
}

function pageKey(cursor: string): string {
  return `/masters/${MASTER_ID}/portfolio?cursor=${cursor}&limit=${String(PORTFOLIO_PAGE_SIZE)}`;
}

function tiles(): number {
  return screen.queryAllByRole('button', { name: /^Paylaşım\. İş/ }).length;
}

beforeEach(() => {
  replies = {};
  requested = [];
});

describe('MasterProfile', () => {
  it('shows the master the order is with: name, services and their work', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = { body: profile() };
    await mount();

    expect(await screen.findByRole('header', { name: PROFILE.displayName })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: copy.profile.servicesTitle })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: copy.profile.worksTitle })).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /^Paylaşım\. İş/ })).toHaveLength(2);
  });

  it('says the master has shared no work yet', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = { body: profile({ posts: [] }) };
    await mount();

    expect(await screen.findByText(copy.profile.emptyTitle)).toBeOnTheScreen();
  });

  it('says the profile is no longer shown on a 404, with a way back', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = { status: 404, body: { code: 'NOT_FOUND' } };
    const { onBack } = await mount();

    expect(await screen.findByText(copy.profile.goneTitle)).toBeOnTheScreen();
    expect(screen.queryByText(copy.profile.retry)).not.toBeOnTheScreen();

    const backs = screen.getAllByRole('button', { name: copy.profile.back });
    await userEvent.press(backs[backs.length - 1]!);
    expect(onBack).toHaveBeenCalled();
  });

  it('says the same, without asking, when the order no longer has a master', async () => {
    replies[`/orders/${ORDER_ID}`] = { body: order({ masterId: null, status: 'SEARCHING' }) };
    await mount();

    expect(await screen.findByText(copy.profile.goneTitle)).toBeOnTheScreen();
    expect(requested.some((key) => key.startsWith('/masters/'))).toBe(false);
  });

  it('offers a retry when the profile could not be read, and shows it once it can', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = { status: 500, body: { code: 'INTERNAL' } };
    await mount();

    const retry = await screen.findByRole('button', { name: copy.profile.retry }, THROUGH_A_RETRY);
    expect(screen.getByText(copy.profile.errorTitle)).toBeOnTheScreen();

    replies[`/masters/${MASTER_ID}/profile`] = { body: profile() };
    await userEvent.press(retry);

    expect(
      await screen.findByRole('header', { name: PROFILE.displayName }, THROUGH_A_RETRY),
    ).toBeOnTheScreen();
  }, 30_000);

  it('reads the next page from the profile’s cursor when the grid’s end comes into view', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = {
      body: profile({ posts: posts(1, 3), nextCursor: 'c1' }),
    };
    replies[`/masters/${MASTER_ID}/portfolio?cursor=c1&limit=${String(PORTFOLIO_PAGE_SIZE)}`] = {
      body: { items: posts(4, 2), nextCursor: null },
    };
    await mount();
    await screen.findByRole('header', { name: PROFILE.displayName });
    expect(requested.some((key) => key.includes('/portfolio'))).toBe(false);

    await scrollToEnd();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Paylaşım\. İş/ })).toHaveLength(5);
    });
  });

  it('keeps reading pages until the last one, and no further', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = {
      body: profile({ posts: posts(1, 3), nextCursor: 'c1' }),
    };
    replies[pageKey('c1')] = { body: { items: posts(4, 2), nextCursor: 'c2' } };
    replies[pageKey('c2')] = { body: { items: posts(6, 2), nextCursor: null } };
    await mount();
    await screen.findByRole('header', { name: PROFILE.displayName });

    await scrollToEnd(1000);
    await waitFor(() => {
      expect(tiles()).toBe(5);
    });

    // The list reports its end only once the new rows are laid out, which it
    // does on its own schedule; the reader simply scrolls again, so does this.
    let height = 2000;
    await waitFor(async () => {
      height += 100;
      await scrollToEnd(height);
      expect(tiles()).toBe(7);
    });

    await scrollToEnd(height + 1000);
    expect(requested.filter((key) => key.includes('/portfolio'))).toEqual([
      pageKey('c1'),
      pageKey('c2'),
    ]);
  });

  it('offers a retry under the grid when a further page fails, and keeps what it has', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = {
      body: profile({ posts: posts(1, 3), nextCursor: 'c1' }),
    };
    replies[pageKey('c1')] = { status: 500, body: { code: 'INTERNAL' } };
    await mount();
    await screen.findByRole('header', { name: PROFILE.displayName });

    await scrollToEnd();
    const retry = await screen.findByRole('button', { name: copy.profile.retry }, THROUGH_A_RETRY);
    expect(tiles()).toBe(3);

    replies[pageKey('c1')] = { body: { items: posts(4, 2), nextCursor: null } };
    await userEvent.press(retry);

    await waitFor(() => {
      expect(tiles()).toBe(5);
    }, THROUGH_A_RETRY);
  }, 30_000);

  it('turns into the gone state when a further page says the profile is no longer shown', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = {
      body: profile({ posts: posts(1, 3), nextCursor: 'c1' }),
    };
    replies[pageKey('c1')] = { status: 404, body: { code: 'NOT_FOUND' } };
    await mount();
    await screen.findByRole('header', { name: PROFILE.displayName });

    // The re-read the 404 prompts answers 404 too.
    replies[`/masters/${MASTER_ID}/profile`] = { status: 404, body: { code: 'NOT_FOUND' } };
    await scrollToEnd();

    expect(await screen.findByText(copy.profile.goneTitle)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.profile.retry })).not.toBeOnTheScreen();
  });

  it('opens the viewer on a tapped post and closes it', async () => {
    replies[`/masters/${MASTER_ID}/profile`] = { body: profile() };
    await mount();

    const push = jest.spyOn(StatusBar, 'pushStackEntry');
    const pop = jest.spyOn(StatusBar, 'popStackEntry');

    await userEvent.press(await screen.findByRole('button', { name: 'Paylaşım. İş 2' }));

    expect(screen.getByText('İş 2')).toBeOnTheScreen();
    // Light status bar text over the dark viewer, set before the modal shows.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ barStyle: 'light-content' }));

    await userEvent.press(screen.getByRole('button', { name: copy.viewer.close }));
    expect(screen.queryByRole('button', { name: copy.viewer.close })).not.toBeOnTheScreen();
    expect(pop).toHaveBeenCalledWith(push.mock.results[0]!.value);

    push.mockRestore();
    pop.mockRestore();
  });
});
