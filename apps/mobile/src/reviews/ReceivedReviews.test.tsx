import type { CursorPage, Review } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { Settings } from '../settings';
import { roleSelected } from '../store/session-slice';
import { ReceivedReviews } from './ReceivedReviews';
import { REVIEWS_COPY as copy } from './reviews-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    orderId: 'order-1',
    authorRole: 'master',
    rating: 5,
    comment: 'Nəzakətli müştəri.',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    revealedAt: '2026-09-21T10:00:00.000Z',
    removedAt: null,
    ...overrides,
  };
}

function page(items: Review[], nextCursor: string | null = null): CursorPage<Review> {
  return { items, nextCursor };
}

/** Keyed by the query string the list asks with; the value is the reply. */
let pages: Record<string, { status?: number; body?: unknown }> = {};
let requested: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const key = `${url.pathname}?${url.searchParams.toString()}`;
    requested.push(key);
    // Anything but the list — settings' notification preferences — gets an
    // empty array, which is what those reads expect.
    const reply =
      pages[key] ?? (url.pathname === '/me/reviews/received' ? { body: page([]) } : { body: [] });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(role: 'customer' | 'master' = 'customer'): Promise<jest.Mock> {
  installTransport();
  const onBack = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <ReceivedReviews role={role} onBack={onBack} />
    </Provider>,
  );
  return onBack;
}

/** "Reviews about me" (issue #228, ADR-0042 § 6). */
describe('ReceivedReviews', () => {
  beforeEach(() => {
    pages = {};
    requested = [];
    mockPush.mockClear();
  });

  it('asks for the reviews about the reader in the role on screen, and shows them', async () => {
    pages['/me/reviews/received?role=master'] = {
      body: page([review({ authorRole: 'customer', comment: 'Tez gəldi.', rating: 4 })]),
    };
    await mount('master');

    expect(await screen.findByText('Tez gəldi.')).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.ratingReading(4))).toBeOnTheScreen();
    expect(screen.getByText(copy.received.from.master)).toBeOnTheScreen();
    expect(requested).toEqual(['/me/reviews/received?role=master']);
  });

  it('shows only revealed reviews — a sealed one never reaches the person it is about', async () => {
    pages['/me/reviews/received?role=customer'] = {
      body: page([
        review({ id: 'r-1', comment: 'Açıq rəy.' }),
        review({ id: 'r-2', comment: 'Möhürlü rəy.', revealedAt: null }),
      ]),
    };
    await mount();

    expect(await screen.findByText('Açıq rəy.')).toBeOnTheScreen();
    expect(screen.queryByText('Möhürlü rəy.')).not.toBeOnTheScreen();
  });

  it('says so when nobody has written about the reader yet', async () => {
    await mount();

    expect(await screen.findByText(copy.received.emptyTitle)).toBeOnTheScreen();
    expect(screen.getByText(copy.received.emptyDescription.customer)).toBeOnTheScreen();
  });

  it('says "no comment" for a rating left without words', async () => {
    pages['/me/reviews/received?role=customer'] = { body: page([review({ comment: null })]) };
    await mount();

    expect(await screen.findByText(copy.noComment)).toBeOnTheScreen();
  });

  it('loads the next page with the server’s cursor when asked', async () => {
    pages['/me/reviews/received?role=customer'] = {
      body: page([review({ id: 'r-1', comment: 'Birinci.' })], 'cursor-2'),
    };
    pages['/me/reviews/received?role=customer&cursor=cursor-2'] = {
      body: page([review({ id: 'r-2', comment: 'İkinci.' })]),
    };
    await mount();

    await fireEvent.press(await screen.findByText(copy.received.loadMore));

    expect(await screen.findByText('İkinci.')).toBeOnTheScreen();
    expect(screen.getByText('Birinci.')).toBeOnTheScreen();
    expect(screen.queryByText(copy.received.loadMore)).not.toBeOnTheScreen();
  });

  it(
    'offers a retry when the list could not be read',
    async () => {
      pages['/me/reviews/received?role=customer'] = { status: 500 };
      await mount();

      const retry = await screen.findByText(copy.retry, {}, THROUGH_A_RETRY);
      pages['/me/reviews/received?role=customer'] = { body: page([review()]) };
      await fireEvent.press(retry);

      expect(
        await screen.findByText(review().comment ?? '', {}, THROUGH_A_RETRY),
      ).toBeOnTheScreen();
    },
    THROUGH_A_RETRY.timeout * 2,
  );

  it('goes back', async () => {
    const onBack = await mount();

    await fireEvent.press(await screen.findByText(copy.back));

    expect(onBack).toHaveBeenCalled();
  });
});

describe('the reviews entry point on the settings screen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    installTransport();
  });

  it.each(['customer', 'master'] as const)('is offered to a %s', async (role) => {
    const store = createTestStore();
    store.dispatch(roleSelected(role));
    await render(
      <Provider store={store}>
        <Settings />
      </Provider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: copy.received.entry }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/(shared)/reviews');
    });
  });
});
