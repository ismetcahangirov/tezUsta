import type { OrderReviews, Review } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MAX_REVIEW_COMMENT_LENGTH, OrderReview } from './OrderReview';
import { REVIEWS_COPY as copy } from './reviews-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

const ORDER_ID = 'order-1';
const REVIEWS_PATH = `/orders/${ORDER_ID}/reviews`;
const REVIEW_PATH = `/orders/${ORDER_ID}/review`;

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    orderId: ORDER_ID,
    authorRole: 'customer',
    rating: 3,
    comment: 'Gec gəldi, amma yaxşı işlədi.',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    revealedAt: null,
    removedAt: null,
    ...overrides,
  };
}

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

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

/** One reply, or a queue of them — the last one repeats. */
let replies: Record<string, Reply | Reply[]> = {};
let sent: { method: string; path: string; body: unknown }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const text = request.method === 'GET' ? '' : await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });

    const configured = replies[key];
    let reply: Reply;
    if (Array.isArray(configured)) {
      reply = (configured.length > 1 ? configured.shift() : configured[0]) ?? { status: 404 };
    } else {
      reply = configured ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '' } } };
    }

    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function writes(method: 'POST' | 'PUT'): unknown[] {
  return sent.filter((request) => request.method === method).map((request) => request.body);
}

async function mount(): Promise<{ onDone: jest.Mock; onBack: jest.Mock }> {
  installTransport();
  const onDone = jest.fn();
  const onBack = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <OrderReview orderId={ORDER_ID} onBack={onBack} onDone={onDone} />
    </Provider>,
  );
  return { onDone, onBack };
}

/**
 * The review screen (issue #227,
 * [ADR-0042](../../../../docs/decisions/ADR-0042-review-policy.md) § 8).
 */
describe('OrderReview', () => {
  beforeEach(() => {
    replies = {};
    sent = [];
  });

  it('asks the customer about their master and submits four stars with a comment', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    replies[`POST ${REVIEW_PATH}`] = { status: 201, body: review({ rating: 4 }) };
    const { onDone } = await mount();

    expect(await screen.findByText(copy.question.customer)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.star(4) }));
    await fireEvent.changeText(
      screen.getByLabelText(copy.commentLabel),
      '  Vaxtında gəldi, səliqəli işlədi.  ',
    );
    await fireEvent.press(screen.getByText(copy.submit));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(writes('POST')).toEqual([{ rating: 4, comment: 'Vaxtında gəldi, səliqəli işlədi.' }]);
  });

  it('asks the master about their customer — the side comes from the server', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews({ role: 'master' }) };
    await mount();

    expect(await screen.findByText(copy.question.master)).toBeOnTheScreen();
  });

  it('refuses to send without a rating, and says so under the stars', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    const { onDone } = await mount();

    await fireEvent.press(await screen.findByText(copy.submit));

    expect(await screen.findByText(copy.ratingRequired)).toBeOnTheScreen();
    expect(writes('POST')).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('sends an empty comment as null — the comment is optional', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    replies[`POST ${REVIEW_PATH}`] = { status: 201, body: review({ rating: 5, comment: null }) };
    await mount();

    await fireEvent.press(await screen.findByRole('button', { name: copy.star(5) }));
    await fireEvent.changeText(screen.getByLabelText(copy.commentLabel), '   ');
    await fireEvent.press(screen.getByText(copy.submit));

    await waitFor(() => {
      expect(writes('POST')).toEqual([{ rating: 5, comment: null }]);
    });
  });

  it('counts the comment against 500 characters and will not take more', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    await mount();

    const field = await screen.findByLabelText(copy.commentLabel);
    expect(field).toHaveProp('maxLength', MAX_REVIEW_COMMENT_LENGTH);
    expect(screen.getByText(copy.commentCount(0, MAX_REVIEW_COMMENT_LENGTH))).toBeOnTheScreen();

    await fireEvent.changeText(field, 'Əla');

    expect(screen.getByText(copy.commentCount(3, MAX_REVIEW_COMMENT_LENGTH))).toBeOnTheScreen();
    expect(
      screen.getByLabelText(copy.commentCountLabel(3, MAX_REVIEW_COMMENT_LENGTH)),
    ).toBeOnTheScreen();
  });

  it.each([
    ['REVIEW_WINDOW_CLOSED', copy.failure.REVIEW_WINDOW_CLOSED],
    ['ORDER_NOT_REVIEWABLE', copy.failure.ORDER_NOT_REVIEWABLE],
    ['REVIEW_ALREADY_REVEALED', copy.failure.REVIEW_ALREADY_REVEALED],
  ] as const)('says what a %s refusal means, and stays on the screen', async (code, message) => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    replies[`POST ${REVIEW_PATH}`] = { status: 409, body: { error: { code, message: '' } } };
    const { onDone } = await mount();

    await fireEvent.press(await screen.findByRole('button', { name: copy.star(2) }));
    await fireEvent.press(screen.getByText(copy.submit));

    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('turns into the edit form when the server says a review already exists', async () => {
    replies[`GET ${REVIEWS_PATH}`] = [
      { body: reviews() },
      { body: reviews({ mine: review(), canReview: false, canEdit: true }) },
    ];
    replies[`POST ${REVIEW_PATH}`] = {
      status: 409,
      body: { error: { code: 'REVIEW_ALREADY_SUBMITTED', message: '' } },
    };
    await mount();

    await fireEvent.press(await screen.findByRole('button', { name: copy.star(5) }));
    await fireEvent.press(screen.getByText(copy.submit));

    expect(await screen.findByText(copy.failure.REVIEW_ALREADY_SUBMITTED)).toBeOnTheScreen();
    expect(await screen.findByText(copy.save)).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.commentLabel)).toHaveProp('value', review().comment);
  });

  it('says a 422 was refused as invalid', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
    replies[`POST ${REVIEW_PATH}`] = {
      status: 422,
      body: { error: { code: 'VALIDATION_FAILED', message: '' } },
    };
    await mount();

    await fireEvent.press(await screen.findByRole('button', { name: copy.star(1) }));
    await fireEvent.press(screen.getByText(copy.submit));

    expect(await screen.findByText(copy.failure.validation)).toBeOnTheScreen();
  });

  it('edits a sealed review: starts from what was written and sends it with PUT', async () => {
    replies[`GET ${REVIEWS_PATH}`] = {
      body: reviews({ mine: review(), canReview: false, canEdit: true }),
    };
    replies[`PUT ${REVIEW_PATH}`] = { body: review({ rating: 4 }) };
    const { onDone } = await mount();

    expect(await screen.findByText(copy.sealedNotice)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.star(3) })).toBeSelected();
    expect(screen.getByRole('button', { name: copy.star(4) })).not.toBeSelected();

    await fireEvent.press(screen.getByRole('button', { name: copy.star(4) }));
    await fireEvent.press(screen.getByText(copy.save));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
    expect(writes('PUT')).toEqual([{ rating: 4, comment: review().comment }]);
    expect(writes('POST')).toHaveLength(0);
  });

  it('is read-only once revealed: no stars to press, no field, no button', async () => {
    replies[`GET ${REVIEWS_PATH}`] = {
      body: reviews({
        mine: review({ revealedAt: '2026-09-21T10:00:00.000Z' }),
        canReview: false,
        canEdit: false,
      }),
    };
    await mount();

    expect(await screen.findByText(copy.revealedNotice)).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.ratingReading(3))).toBeOnTheScreen();
    expect(screen.getByText(review().comment ?? '')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.star(1) })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.commentLabel)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.save)).not.toBeOnTheScreen();
  });

  it('shows the other side’s review once it is revealed', async () => {
    replies[`GET ${REVIEWS_PATH}`] = {
      body: reviews({
        mine: review({ revealedAt: '2026-09-21T10:00:00.000Z' }),
        theirs: review({
          id: 'review-2',
          authorRole: 'master',
          rating: 5,
          comment: 'Nəzakətli müştəri.',
          revealedAt: '2026-09-21T10:00:00.000Z',
        }),
        canReview: false,
      }),
    };
    await mount();

    expect(await screen.findByText(copy.theirsHeading.customer)).toBeOnTheScreen();
    expect(screen.getByText('Nəzakətli müştəri.')).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.ratingReading(5))).toBeOnTheScreen();
  });

  it('tells its author a removed review was removed', async () => {
    replies[`GET ${REVIEWS_PATH}`] = {
      body: reviews({
        mine: review({
          revealedAt: '2026-09-21T10:00:00.000Z',
          removedAt: '2026-09-22T10:00:00.000Z',
        }),
        canReview: false,
      }),
    };
    await mount();

    expect(await screen.findByText(copy.removedNotice)).toBeOnTheScreen();
  });

  it('says the window has closed when there is nothing left to write', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews({ canReview: false }) };
    await mount();

    expect(await screen.findByText(copy.closedTitle)).toBeOnTheScreen();
    expect(screen.queryByText(copy.submit)).not.toBeOnTheScreen();
  });

  it('says the order is not finished yet before it completes', async () => {
    replies[`GET ${REVIEWS_PATH}`] = { body: reviews({ canReview: false, windowClosesAt: null }) };
    await mount();

    expect(await screen.findByText(copy.notYetTitle)).toBeOnTheScreen();
  });

  it('says plainly when there is no such order for this reader', async () => {
    await mount();

    expect(await screen.findByText(copy.notFoundTitle)).toBeOnTheScreen();
    expect(screen.queryByText(copy.retry)).not.toBeOnTheScreen();
  });

  it(
    'offers a retry when the reviews could not be read',
    async () => {
      replies[`GET ${REVIEWS_PATH}`] = { status: 500 };
      await mount();

      const retry = await screen.findByText(copy.retry, {}, THROUGH_A_RETRY);
      replies[`GET ${REVIEWS_PATH}`] = { body: reviews() };
      await fireEvent.press(retry);

      expect(await screen.findByText(copy.submit, {}, THROUGH_A_RETRY)).toBeOnTheScreen();
    },
    THROUGH_A_RETRY.timeout * 2,
  );

  it('goes back from every state', async () => {
    const { onBack } = await mount();

    await fireEvent.press(await screen.findByText(copy.back));

    expect(onBack).toHaveBeenCalled();
  });
});
