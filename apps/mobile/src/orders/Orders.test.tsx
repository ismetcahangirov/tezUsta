import type { Order } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import type { AppStore } from '../store';
import { ordersApi } from './order-endpoints';
import { Orders } from './Orders';
import { ORDERS_COPY as copy } from './orders-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `ServiceCatalogue.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

const SECOND_PAGE_CURSOR = 'cursor-to-page-two';

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    status: 'SEARCHING',
    serviceId: 'svc-1',
    addressId: 'addr-1',
    description: `Problem ${id}`,
    priceMinor: null,
    masterId: null,
    redispatchCount: 0,
    acceptedAt: null,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportError?: true;
}

let replies: Record<string, Reply> = {};
let requested: string[] = [];

/** The cursor is part of the identity of a page request, so it is part of the key. */
function routeKey(method: string, pathname: string, cursor: string | null = null): string {
  return cursor === null ? `${method} ${pathname}` : `${method} ${pathname}?cursor=${cursor}`;
}

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const key = routeKey(request.method, url.pathname, url.searchParams.get('cursor'));
    requested.push(key);

    const reply = replies[key] ?? { body: { items: [], nextCursor: null } };

    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function firstPage(items: readonly Order[], nextCursor: string | null = null): void {
  replies[routeKey('GET', '/orders')] = { body: { items, nextCursor } };
}

async function mount(): Promise<{
  onSelectOrder: jest.Mock;
  onBrowseServices: jest.Mock;
  store: AppStore;
}> {
  installTransport();
  const onSelectOrder = jest.fn();
  const onBrowseServices = jest.fn();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <Orders onSelectOrder={onSelectOrder} onBrowseServices={onBrowseServices} />
    </Provider>,
  );
  return { onSelectOrder, onBrowseServices, store };
}

/**
 * The customer's order list (issue #160,
 * [ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
 *
 * Every request state is asserted, for the reason `OrderDetail.test.tsx` gives:
 * a state nobody renders deliberately is how an indefinite spinner appears.
 */
describe('Orders', () => {
  beforeEach(() => {
    replies = {};
    requested = [];
  });

  it('shows a named loading state rather than a bare spinner', async () => {
    await mount();

    expect(screen.getByLabelText(copy.list.loading)).toBeOnTheScreen();
  });

  it('renders the orders the server returned, in the customer’s own words', async () => {
    firstPage([
      order('order-1', { description: 'Mətbəxdə kran sızır.' }),
      order('order-2', { status: 'PAID', priceMinor: 4500 }),
    ]);
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Mətbəxdə kran sızır.')).toBeOnTheScreen();
    });
    expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    expect(screen.getByText(copy.status.PAID.label)).toBeOnTheScreen();
    // The price, through `formatOrderPrice`: 4500 minor units is 45 manat.
    expect(screen.getByText(/45/)).toBeOnTheScreen();
  });

  /**
   * The point of the list for somebody waiting at home: the order with a master
   * attached to it is not buried among the finished ones (ADR-0030 § 3).
   */
  it('separates what is still going from what is over', async () => {
    firstPage([
      order('order-1', { status: 'MASTER_ON_THE_WAY' }),
      order('order-2', { status: 'CANCELLED' }),
    ]);
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.list.openHeading)).toBeOnTheScreen();
    });
    expect(screen.getByText(copy.list.finishedHeading)).toBeOnTheScreen();
  });

  it('shows no headings when there is nothing to contrast', async () => {
    firstPage([order('order-1'), order('order-2')]);
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Problem order-1')).toBeOnTheScreen();
    });
    expect(screen.queryByText(copy.list.openHeading)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.list.finishedHeading)).not.toBeOnTheScreen();
  });

  it('sends a customer with no orders to the catalogue, deliberately', async () => {
    firstPage([]);
    const { onBrowseServices } = await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.list.emptyTitle)).toBeOnTheScreen();
    });
    expect(screen.queryByLabelText(copy.list.loading)).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: copy.list.emptyAction }));

    expect(onBrowseServices).toHaveBeenCalled();
  });

  it('opens the order a row belongs to, by id and nothing else', async () => {
    firstPage([order('order-1', { description: 'Qapı kilidi işləmir.' })]);
    const { onSelectOrder } = await mount();

    await waitFor(() => {
      expect(screen.getByText('Qapı kilidi işləmir.')).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByText('Qapı kilidi işləmir.'));

    expect(onSelectOrder).toHaveBeenCalledWith('order-1');
  });

  /**
   * **The acceptance criterion the cursor exists for**: a second page arrives
   * without repeating a row from the first, and it is asked for with the
   * server's cursor rather than with an offset this client computed.
   */
  it('loads a second page without repeating a row from the first', async () => {
    firstPage([order('order-1'), order('order-2')], SECOND_PAGE_CURSOR);
    replies[routeKey('GET', '/orders', SECOND_PAGE_CURSOR)] = {
      body: { items: [order('order-3')], nextCursor: null },
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Problem order-1')).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByRole('button', { name: copy.list.loadMore }));

    await waitFor(() => {
      expect(screen.getByText('Problem order-3')).toBeOnTheScreen();
    });
    expect(requested).toContain(routeKey('GET', '/orders', SECOND_PAGE_CURSOR));
    expect(screen.getAllByText('Problem order-1')).toHaveLength(1);
    expect(screen.getAllByText('Problem order-2')).toHaveLength(1);
  });

  it('offers no way to page when the server says there is nothing after this', async () => {
    firstPage([order('order-1')]);
    await mount();

    await waitFor(() => {
      expect(screen.getByText('Problem order-1')).toBeOnTheScreen();
    });
    expect(screen.queryByRole('button', { name: copy.list.loadMore })).not.toBeOnTheScreen();
  });

  it('offers a retry when the transport failed with nothing to show', async () => {
    replies[routeKey('GET', '/orders')] = { transportError: true };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.list.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByRole('button', { name: copy.retry })).toBeOnTheScreen();
  }, 30_000);

  /**
   * A refresh that failed over rows already on screen. They stay — a customer
   * checking on a master is better served by slightly old rows plus a caption
   * than by an empty screen — and the banner is what stops them being
   * presented as current.
   */
  it('keeps loaded orders on screen when a refresh fails, and says they are stale', async () => {
    firstPage([order('order-1')]);
    const { store } = await mount();

    await waitFor(() => {
      expect(screen.getByText('Problem order-1')).toBeOnTheScreen();
    });

    replies[routeKey('GET', '/orders')] = { transportError: true };
    store.dispatch(ordersApi.util.invalidateTags([{ type: 'Order', id: 'LIST' }]));

    await waitFor(() => {
      expect(screen.getByText(copy.list.staleNotice)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    expect(screen.getByText('Problem order-1')).toBeOnTheScreen();
  }, 30_000);
});
