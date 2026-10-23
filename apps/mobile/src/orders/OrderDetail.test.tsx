import type { Address, Order, OrderPhoto, Service } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { ordersApi } from './order-endpoints';
import { OrderDetail } from './OrderDetail';
import { formatOrderPrice } from './format-order-price';
import { ORDERS_COPY as copy } from './orders-copy';
import { REVIEWS_COPY } from '../reviews/reviews-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

const ORDER_ID = 'order-1';
const SERVICE_ID = 'svc-1';

const SERVICE = {
  id: SERVICE_ID,
  categoryId: 'cat-1',
  slug: 'kran-temiri',
  name: 'Kran təmiri',
  description: null,
  pricing: { kind: 'fixed', basePriceMinor: 1500, currency: 'AZN' },
  displayOrder: 1,
} as unknown as Service;

const HOME: Address = {
  id: 'addr-1',
  label: 'Ev',
  formattedAddress: 'Nizami küçəsi 203',
  building: '12B',
  entrance: null,
  floor: null,
  apartment: '48',
  landmarkNote: null,
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    status: 'SEARCHING',
    serviceId: SERVICE_ID,
    addressId: HOME.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: null,
    pricingKind: 'fixed',
    priceApprovedAt: null,
    masterId: null,
    redispatchCount: 0,
    acceptedAt: null,
    arrivalPromise: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PHOTO: OrderPhoto = {
  id: 'photo-1',
  orderId: ORDER_ID,
  status: 'attached',
  sizeBytes: 2048,
  submittedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportError?: true;
}

/** A function reply is asked on each request, so a test can change its answer after a write. */
let replies: Record<string, Reply | (() => Reply)> = {};
let requested: string[] = [];
/** The last body sent to each route, for the writes the inspection price makes (ADR-0060). */
let bodies: Record<string, unknown> = {};

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function defaultReply(method: string, pathname: string): Reply {
  if (method === 'GET' && pathname === `/orders/${ORDER_ID}`) {
    return { body: order() };
  }
  if (method === 'GET' && pathname === `/orders/${ORDER_ID}/photos`) {
    return { body: [] };
  }
  if (method === 'GET' && pathname === '/addresses') {
    return { body: [HOME] };
  }
  if (method === 'GET' && pathname === `/services/${SERVICE_ID}`) {
    return { body: SERVICE };
  }
  return { status: 200, body: {} };
}

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const key = routeKey(request.method, url.pathname);
    requested.push(key);
    if (request.method !== 'GET') {
      const text = await request.clone().text();
      bodies[key] = text === '' ? null : (JSON.parse(text) as unknown);
    }

    const configured = replies[key];
    const reply =
      (typeof configured === 'function' ? configured() : configured) ??
      defaultReply(request.method, url.pathname);

    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

async function mount(onOpenReview?: () => void): Promise<{ onBack: jest.Mock; store: AppStore }> {
  installTransport();
  const onBack = jest.fn();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <OrderDetail orderId={ORDER_ID} onBack={onBack} onOpenReview={onOpenReview} />
    </Provider>,
  );
  return { onBack, store };
}

/**
 * The customer's order screen (issue #155,
 * [ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
 *
 * Every state the screen can be in is asserted, because "no indefinite spinner"
 * is one of the issue's acceptance criteria and a state nobody renders
 * deliberately is how one appears.
 */
describe('OrderDetail', () => {
  beforeEach(() => {
    replies = {};
    requested = [];
    bodies = {};
  });

  it('shows a named loading state rather than a bare spinner', async () => {
    await mount();

    expect(screen.getByLabelText(copy.detail.loading)).toBeOnTheScreen();
  });

  it('renders the order the server returned', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    });
    expect(screen.getByText(copy.status.SEARCHING.next)).toBeOnTheScreen();
    expect(screen.getByText('Mətbəxdə kran sızır.')).toBeOnTheScreen();
    expect(screen.getByText(HOME.formattedAddress)).toBeOnTheScreen();
    expect(screen.getByText(SERVICE.name)).toBeOnTheScreen();
  });

  /**
   * **The claim the screen turns on.** Nothing about the order arrives through
   * navigation, so the status on screen can only be the one the server sent —
   * here a status the caller could not have known, because the order was
   * accepted after whoever navigated here left the previous screen.
   */
  it('renders the server’s status, never one it was navigated with', async () => {
    replies[routeKey('GET', `/orders/${ORDER_ID}`)] = {
      body: order({ status: 'MASTER_ON_THE_WAY', priceMinor: 4500, masterId: 'master-1' }),
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.status.MASTER_ON_THE_WAY.label)).toBeOnTheScreen();
    });
    expect(screen.getByText(/45/)).toBeOnTheScreen();
    expect(requested).toContain(routeKey('GET', `/orders/${ORDER_ID}`));
  });

  /**
   * The API answers 404 for an order that is not the caller's, never 403
   * (`orders.controller.ts`). Both must read as a plain message: an error with
   * a retry button would hand somebody a control that can never succeed.
   */
  it.each([404, 403])('says an order is not available for a %s, plainly', async (status) => {
    replies[routeKey('GET', `/orders/${ORDER_ID}`)] = { status, body: { code: 'NOT_FOUND' } };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.detail.notFoundTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.detail.errorTitle)).not.toBeOnTheScreen();
  });

  it('offers a retry when the transport failed with nothing to show', async () => {
    replies[routeKey('GET', `/orders/${ORDER_ID}`)] = { transportError: true };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.detail.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByRole('button', { name: copy.retry })).toBeOnTheScreen();
  }, 30_000);

  /**
   * A refresh that failed over an order already on screen. The order stays —
   * stale content beats an empty screen for somebody waiting on a master — and
   * the banner is what stops it being presented as current.
   */
  it('keeps a loaded order on screen when a refresh fails, and says it is stale', async () => {
    const { store } = await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    });

    replies[routeKey('GET', `/orders/${ORDER_ID}`)] = { transportError: true };
    store.dispatch(ordersApi.util.invalidateTags([{ type: 'Order', id: ORDER_ID }]));

    await waitFor(() => {
      expect(screen.getByText(copy.detail.staleNotice)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    // The order is still there. A customer waiting on a master is better served
    // by slightly old information plus a caption than by an empty screen.
    expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
  }, 30_000);

  it('renders attached photos, and nothing at all when there are none', async () => {
    replies[routeKey('GET', `/orders/${ORDER_ID}/photos`)] = { body: [PHOTO] };
    replies[routeKey('GET', `/orders/${ORDER_ID}/photos/${PHOTO.id}/download`)] = {
      body: { url: 'https://r2.example/photo-1', expiresAt: '2026-01-01T00:05:00.000Z' },
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.detail.photos)).toBeOnTheScreen();
    });
    await waitFor(() => {
      expect(requested).toContain(
        routeKey('GET', `/orders/${ORDER_ID}/photos/${PHOTO.id}/download`),
      );
    });
  });

  it('shows no photo section for an order without photos', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.detail.photos)).not.toBeOnTheScreen();
  });

  /** Issue #228, ADR-0042 § 6: the assigned master's rating, from the order read. */
  it('shows the assigned master’s rating on the status card', async () => {
    replies[routeKey('GET', `/orders/${ORDER_ID}`)] = {
      body: {
        ...order({ status: 'MASTER_ON_THE_WAY', masterId: 'master-1', priceMinor: 1500 }),
        unreadMessageCount: 0,
        masterRating: { ratingAverage: null, ratingCount: 0 },
      },
    };
    await mount();

    expect(await screen.findByText(REVIEWS_COPY.rating.master)).toBeOnTheScreen();
    expect(screen.getByText(REVIEWS_COPY.rating.none)).toBeOnTheScreen();
  });

  /** Issue #227, ADR-0042 § 1: the ask to review, on the status card's screen. */
  describe('the review prompt', () => {
    const REVIEWS = `/orders/${ORDER_ID}/reviews`;
    const openReviews = {
      orderId: ORDER_ID,
      role: 'customer',
      mine: null,
      theirs: null,
      windowClosesAt: '2026-09-27T10:00:00.000Z',
      canReview: true,
      canEdit: false,
    };

    it('asks a customer to review a completed order, and opens the review', async () => {
      replies[routeKey('GET', `/orders/${ORDER_ID}`)] = {
        body: order({ status: 'COMPLETED', masterId: 'master-1', priceMinor: 1500 }),
      };
      replies[routeKey('GET', REVIEWS)] = { body: openReviews };
      const onOpenReview = jest.fn();
      await mount(onOpenReview);

      await fireEvent.press(await screen.findByText(REVIEWS_COPY.prompt.title));

      expect(onOpenReview).toHaveBeenCalled();
    });

    it('is gone once the customer has reviewed', async () => {
      replies[routeKey('GET', `/orders/${ORDER_ID}`)] = {
        body: order({ status: 'COMPLETED', masterId: 'master-1', priceMinor: 1500 }),
      };
      replies[routeKey('GET', REVIEWS)] = {
        body: { ...openReviews, canReview: false, canEdit: true, mine: { id: 'review-1' } },
      };
      await mount(jest.fn());

      await waitFor(() => {
        expect(requested).toContain(routeKey('GET', REVIEWS));
      });
      expect(screen.queryByText(REVIEWS_COPY.prompt.title)).not.toBeOnTheScreen();
    });

    it('asks nothing about reviews while the order is still under way', async () => {
      replies[routeKey('GET', `/orders/${ORDER_ID}`)] = {
        body: order({ status: 'IN_PROGRESS', masterId: 'master-1', priceMinor: 1500 }),
      };
      await mount(jest.fn());

      await waitFor(() => {
        expect(screen.getByText(copy.status.IN_PROGRESS.label)).toBeOnTheScreen();
      });
      expect(requested).not.toContain(routeKey('GET', REVIEWS));
      expect(screen.queryByText(REVIEWS_COPY.prompt.title)).not.toBeOnTheScreen();
    });
  });

  it('leaves the way back to the caller', async () => {
    const { onBack } = await mount();

    await fireEvent.press(screen.getByRole('button', { name: copy.detail.back }));

    expect(onBack).toHaveBeenCalled();
  });

  describe('the inspection price (ADR-0060)', () => {
    const GET_ORDER = `GET /orders/${ORDER_ID}`;
    const APPROVE = `POST /orders/${ORDER_ID}/price/approval`;
    const DECLINE = `POST /orders/${ORDER_ID}/price/decline`;
    const quoted = (overrides: Partial<Order> = {}): Order =>
      order({
        status: 'MASTER_ARRIVED',
        pricingKind: 'inspection',
        priceMinor: 5000,
        masterId: 'master-1',
        acceptedAt: '2026-01-01T00:05:00.000Z',
        ...overrides,
      });

    it('says the master is looking before there is a quote', async () => {
      replies[GET_ORDER] = { body: quoted({ priceMinor: null }) };
      await mount();

      expect(await screen.findByText(copy.detail.quote.awaiting)).toBeOnTheScreen();
      expect(screen.queryByText(copy.detail.quote.approve)).not.toBeOnTheScreen();
    });

    it('shows the quote as a proposal, and approves the amount on screen', async () => {
      let approved = false;
      replies[GET_ORDER] = () => ({
        body: quoted(approved ? { priceApprovedAt: '2026-01-01T00:20:00.000Z' } : {}),
      });
      replies[APPROVE] = () => {
        approved = true;
        return { body: quoted({ priceApprovedAt: '2026-01-01T00:20:00.000Z' }) };
      };
      await mount();

      expect(await screen.findByText(copy.detail.quote.title)).toBeOnTheScreen();
      expect(screen.getByText(formatOrderPrice(5000))).toBeOnTheScreen();
      // Not yet "the price": the status card keeps its unset line.
      expect(screen.getByText(copy.detail.priceNotSet)).toBeOnTheScreen();

      await fireEvent.press(screen.getByText(copy.detail.quote.approve));

      await waitFor(() => {
        expect(bodies[APPROVE]).toEqual({ amountMinor: 5000 });
      });
      await waitFor(() => {
        expect(screen.queryByText(copy.detail.quote.approve)).not.toBeOnTheScreen();
      });
      expect(screen.getByText(formatOrderPrice(5000))).toBeOnTheScreen();
    });

    it('says the price changed when the approval was of a stale quote', async () => {
      replies[GET_ORDER] = { body: quoted() };
      replies[APPROVE] = {
        status: 409,
        body: { error: { code: 'ORDER_PRICE_STALE', message: 'changed' } },
      };
      await mount();

      await fireEvent.press(await screen.findByText(copy.detail.quote.approve));

      expect(await screen.findByText(copy.detail.quote.stale)).toBeOnTheScreen();
    });

    it('asks before a decline, and then declines the amount on screen', async () => {
      replies[GET_ORDER] = { body: quoted() };
      replies[DECLINE] = { body: quoted({ status: 'CANCELLED' }) };
      await mount();

      await fireEvent.press(await screen.findByText(copy.detail.quote.decline));
      expect(screen.getByText(copy.detail.quote.declineTitle)).toBeOnTheScreen();
      expect(requested).not.toContain(DECLINE);

      await fireEvent.press(screen.getByText(copy.detail.quote.declineConfirm));

      await waitFor(() => {
        expect(bodies[DECLINE]).toEqual({ amountMinor: 5000 });
      });
    });

    it('shows nothing of the kind on a fixed-price order', async () => {
      replies[GET_ORDER] = { body: quoted({ pricingKind: 'fixed', priceMinor: 6700 }) };
      await mount();

      expect(await screen.findByText(formatOrderPrice(6700))).toBeOnTheScreen();
      expect(screen.queryByText(copy.detail.quote.title)).not.toBeOnTheScreen();
      expect(screen.queryByText(copy.detail.quote.awaiting)).not.toBeOnTheScreen();
    });
  });
});
