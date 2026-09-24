import type { OrderReviews, Review } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { OrderReview } from './OrderReview';
import { OrderReviewPrompt } from './OrderReviewPrompt';
import { ReviewPrompt } from './ReviewPrompt';
import { REVIEWS_COPY as copy } from './reviews-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';

const MINE: Review = {
  id: 'review-1',
  orderId: ORDER_ID,
  authorRole: 'customer',
  rating: 4,
  comment: 'Yaxşı işlədi.',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  revealedAt: null,
  removedAt: null,
};

function reviews(overrides: Partial<OrderReviews> = {}): OrderReviews {
  return {
    orderId: ORDER_ID,
    role: 'customer',
    mine: null,
    theirs: null,
    windowClosesAt: '2026-09-27T10:00:00.000Z',
    canReview: true,
    canEdit: false,
    ...overrides,
  };
}

/** What the server holds — the tests change it the way a submit would. */
let serverReviews: OrderReviews = reviews();
let requested: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);
    requested.push(`${request.method} ${pathname}`);

    if (request.method === 'GET' && pathname === `/orders/${ORDER_ID}/reviews`) {
      return Promise.resolve(
        new Response(JSON.stringify(serverReviews), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (request.method === 'POST' && pathname === `/orders/${ORDER_ID}/review`) {
      serverReviews = reviews({ mine: MINE, canReview: false, canEdit: true });
      return Promise.resolve(
        new Response(JSON.stringify(MINE), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

describe('ReviewPrompt', () => {
  it('asks the reader about the other side, and opens the review on a tap', async () => {
    const onPress = jest.fn();
    await render(<ReviewPrompt viewer="master" onPress={onPress} />);

    expect(screen.getByText(copy.prompt.subtitle.master)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(copy.prompt.title));

    expect(onPress).toHaveBeenCalled();
  });
});

describe('OrderReviewPrompt', () => {
  beforeEach(() => {
    serverReviews = reviews();
    requested = [];
    installTransport();
  });

  async function mount(orderId: string | null = ORDER_ID): Promise<jest.Mock> {
    const onPress = jest.fn();
    await render(
      <Provider store={createTestStore()}>
        <OrderReviewPrompt orderId={orderId} viewer="customer" onPress={onPress} />
      </Provider>,
    );
    return onPress;
  }

  it('shows while the reader may still review, and hands over the order id', async () => {
    const onPress = await mount();

    await fireEvent.press(await screen.findByText(copy.prompt.title));

    expect(onPress).toHaveBeenCalledWith(ORDER_ID);
  });

  it('is absent once the reader has reviewed', async () => {
    serverReviews = reviews({ mine: MINE, canReview: false, canEdit: true });
    await mount();

    await waitFor(() => {
      expect(requested).toContain(`GET /orders/${ORDER_ID}/reviews`);
    });
    expect(screen.queryByText(copy.prompt.title)).not.toBeOnTheScreen();
  });

  it('is absent once the window has closed', async () => {
    serverReviews = reviews({ canReview: false });
    await mount();

    await waitFor(() => {
      expect(requested).toContain(`GET /orders/${ORDER_ID}/reviews`);
    });
    expect(screen.queryByText(copy.prompt.title)).not.toBeOnTheScreen();
  });

  it('asks nothing, and shows nothing, without an order', async () => {
    await mount(null);

    expect(screen.queryByText(copy.prompt.title)).not.toBeOnTheScreen();
    expect(requested).toEqual([]);
  });

  /**
   * The issue's first acceptance criterion, end to end over one store: tap the
   * prompt, pick four stars, write a comment, submit — and the prompt is gone.
   */
  it('disappears after the review it opened is submitted', async () => {
    function Screen(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return open ? (
        <OrderReview
          orderId={ORDER_ID}
          onBack={() => {
            setOpen(false);
          }}
          onDone={() => {
            setOpen(false);
          }}
        />
      ) : (
        <OrderReviewPrompt
          orderId={ORDER_ID}
          viewer="customer"
          onPress={() => {
            setOpen(true);
          }}
        />
      );
    }

    await render(
      <Provider store={createTestStore()}>
        <Screen />
      </Provider>,
    );

    await fireEvent.press(await screen.findByText(copy.prompt.title));
    await fireEvent.press(await screen.findByRole('button', { name: copy.star(4) }));
    await fireEvent.changeText(screen.getByLabelText(copy.commentLabel), 'Yaxşı işlədi.');
    await fireEvent.press(screen.getByText(copy.submit));

    await waitFor(() => {
      expect(screen.queryByText(copy.submit)).not.toBeOnTheScreen();
    });
    // The submit invalidated the order's reviews, so they were read again —
    // that re-read, not a local flag, is what takes the card away.
    await waitFor(() => {
      expect(requested.filter((r) => r === `GET /orders/${ORDER_ID}/reviews`).length).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByText(copy.prompt.title)).not.toBeOnTheScreen();
    });
    expect(requested).toContain(`POST /orders/${ORDER_ID}/review`);
  });
});
