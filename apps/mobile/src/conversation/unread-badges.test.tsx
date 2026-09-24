import type {
  Address,
  Conversation as ConversationContract,
  CurrentMasterJob,
  Message,
  MessageNewRealtimeEvent,
  OrderSummary,
} from '@tezusta/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { JobDetail } from '../master-jobs/JobDetail';
import { OrderDetail } from '../orders/OrderDetail';
import { Orders } from '../orders/Orders';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { MESSAGE_NEW_EVENT } from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { signedIn } from '../store/session-slice';
import { Conversation } from './Conversation';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import { READ_RECEIPT_DELAY_MS } from './useReadReceipts';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';

const HOME: Address = {
  id: 'addr-1',
  label: 'Ev',
  formattedAddress: 'Nizami küçəsi 203',
  building: null,
  entrance: null,
  floor: null,
  apartment: null,
  landmarkNote: null,
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: ORDER_ID,
    status: 'MASTER_ON_THE_WAY',
    serviceId: 'svc-1',
    addressId: HOME.id,
    description: 'Mətbəxdə kran sızır.',
    priceMinor: 6700,
    masterId: 'master-1',
    redispatchCount: 0,
    acceptedAt: '2026-09-23T08:00:00.000Z',
    createdAt: '2026-09-23T07:55:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
    unreadMessageCount: 0,
    ...overrides,
  };
}

function conversation(overrides: Partial<ConversationContract> = {}): ConversationContract {
  return {
    id: 'conversation-1',
    orderId: ORDER_ID,
    unreadCount: 0,
    writable: true,
    createdAt: '2026-09-23T08:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'conversation-1',
    senderKind: 'master',
    body: `Mesaj ${id}`,
    attachments: [],
    createdAt: '2026-09-23T08:10:00.000Z',
    readAt: null,
    ...overrides,
  };
}

let replies: Record<string, { status?: number; body?: unknown }> = {};
let sent: { method: string; path: string }[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    sent.push({ method: request.method, path: url.pathname });
    const reply = replies[`${request.method} ${url.pathname}`] ?? {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: '' } },
    };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

let currentSockets: FakeSocketFactory | undefined;

async function mountLive(children: React.ReactNode, role: 'customer' | 'master' = 'customer') {
  installTransport();
  const sockets = createFakeSocketFactory();
  currentSockets = sockets;
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: [role] }));

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        {children}
      </RealtimeProvider>
    </Provider>,
  );
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });
}

async function publishMessage(id: string): Promise<void> {
  await actAndSettle(() => {
    currentSockets?.latest().serverEmit(MESSAGE_NEW_EVENT, {
      orderId: ORDER_ID,
      message: message(id),
      at: 9_000,
    } satisfies MessageNewRealtimeEvent);
  });
}

beforeEach(() => {
  sent = [];
  replies = {
    [`GET /orders/${ORDER_ID}`]: { body: order() },
    [`GET /orders/${ORDER_ID}/photos`]: { body: [] },
    'GET /addresses': { body: [HOME] },
    'GET /services/svc-1': { body: { id: 'svc-1', name: 'Santexnik' } },
  };
});

/**
 * The unread count where the order is (issue #182, ADR-0033 § 6): on the
 * order's row in the list, on the order screen's way into the conversation,
 * and on the master's job screen. Asserted on what the user sees.
 */
describe('the unread badge', () => {
  describe('on the customer’s order list', () => {
    it('shows each order’s own count, from the list itself', async () => {
      replies['GET /orders'] = {
        body: {
          items: [
            order({ unreadMessageCount: 2 }),
            order({ id: 'order-2', description: 'Qapı kilidi.', unreadMessageCount: 0 }),
          ],
          nextCursor: null,
        },
      };
      await mountLive(<Orders onSelectOrder={jest.fn()} onBrowseServices={jest.fn()} />);

      expect(await screen.findByLabelText(copy.unread(2))).toBeOnTheScreen();
      expect(screen.getByText('2')).toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.unread(0))).toBeNull();
      // One request for the whole list — no conversation request per row.
      expect(sent.filter((call) => call.path.includes('/conversation'))).toHaveLength(0);
    });

    it('goes up when the master writes, without re-reading the list', async () => {
      replies['GET /orders'] = {
        body: { items: [order({ unreadMessageCount: 1 })], nextCursor: null },
      };
      await mountLive(<Orders onSelectOrder={jest.fn()} onBrowseServices={jest.fn()} />);
      await screen.findByLabelText(copy.unread(1));
      const reads = sent.filter((call) => call.path === '/orders').length;

      await publishMessage('m-9');

      expect(await screen.findByLabelText(copy.unread(2))).toBeOnTheScreen();
      expect(sent.filter((call) => call.path === '/orders')).toHaveLength(reads);
    });

    it('clears once the customer has read the conversation', async () => {
      replies['GET /orders'] = {
        body: { items: [order({ unreadMessageCount: 1 })], nextCursor: null },
      };
      replies[`GET /orders/${ORDER_ID}/conversation`] = { body: conversation({ unreadCount: 1 }) };
      replies[`GET /orders/${ORDER_ID}/messages`] = {
        body: { items: [message('m-1', { body: 'Yoldayam.' })], nextCursor: null },
      };
      replies[`POST /orders/${ORDER_ID}/messages/read`] = {
        body: conversation({ unreadCount: 0 }),
      };
      jest.useFakeTimers({ advanceTimers: true });

      try {
        await mountLive(
          <View>
            <Orders onSelectOrder={jest.fn()} onBrowseServices={jest.fn()} />
            <Conversation orderId={ORDER_ID} viewer="customer" onBack={jest.fn()} />
          </View>,
        );
        await screen.findByLabelText(copy.unread(1));
        await screen.findByText('Yoldayam.');

        await act(async () => {
          await fireEvent(screen.getByTestId('conversation-messages'), 'viewableItemsChanged', {
            viewableItems: [
              {
                item: { kind: 'message', key: 'm-1', message: message('m-1') },
                key: 'm-1',
                index: 0,
                isViewable: true,
              },
            ],
            changed: [],
          });
          jest.advanceTimersByTime(READ_RECEIPT_DELAY_MS);
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(screen.queryByLabelText(copy.unread(1))).toBeNull();
        });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('on the customer’s order screen', () => {
    it('sits on the way into the conversation, and opens it', async () => {
      replies[`GET /orders/${ORDER_ID}`] = { body: order({ unreadMessageCount: 3 }) };
      const onOpenConversation = jest.fn();
      await mountLive(
        <OrderDetail
          orderId={ORDER_ID}
          onBack={jest.fn()}
          onOpenConversation={onOpenConversation}
        />,
      );

      const entry = await screen.findByRole('button', {
        name: `${copy.entry.title}, ${copy.unread(3)}`,
      });
      expect(screen.getByText(copy.entry.open.customer)).toBeOnTheScreen();

      await act(async () => {
        await fireEvent.press(entry);
        await Promise.resolve();
      });
      expect(onOpenConversation).toHaveBeenCalledTimes(1);
    });

    it('counts a message the master writes while the customer is on the order', async () => {
      replies[`GET /orders/${ORDER_ID}`] = { body: order({ unreadMessageCount: 0 }) };
      await mountLive(
        <OrderDetail orderId={ORDER_ID} onBack={jest.fn()} onOpenConversation={jest.fn()} />,
      );
      await screen.findByRole('button', { name: copy.entry.title });
      const reads = sent.filter((call) => call.path === `/orders/${ORDER_ID}`).length;

      await publishMessage('m-4');

      expect(await screen.findByLabelText(copy.unread(1))).toBeOnTheScreen();
      expect(sent.filter((call) => call.path === `/orders/${ORDER_ID}`)).toHaveLength(reads);
    });

    it('is not there before a master has taken the order', async () => {
      replies[`GET /orders/${ORDER_ID}`] = {
        body: order({ status: 'SEARCHING', masterId: null, acceptedAt: null, priceMinor: null }),
      };
      await mountLive(
        <OrderDetail orderId={ORDER_ID} onBack={jest.fn()} onOpenConversation={jest.fn()} />,
      );

      await screen.findByText('Mətbəxdə kran sızır.');
      expect(screen.queryByText(copy.entry.title)).toBeNull();
    });

    it('stays on a finished order, as a transcript', async () => {
      replies[`GET /orders/${ORDER_ID}`] = { body: order({ status: 'COMPLETED' }) };
      await mountLive(
        <OrderDetail orderId={ORDER_ID} onBack={jest.fn()} onOpenConversation={jest.fn()} />,
      );

      expect(await screen.findByText(copy.entry.closed)).toBeOnTheScreen();
    });
  });

  describe('on the master’s job screen', () => {
    it('shows the master’s own unread count and opens the conversation', async () => {
      const job: CurrentMasterJob = {
        job: {
          orderId: ORDER_ID,
          offerId: 'offer-1',
          customerRating: { ratingAverage: null, ratingCount: 0 },
          status: 'MASTER_ON_THE_WAY',
          serviceId: 'svc-1',
          description: 'Mətbəxdə kran sızır.',
          priceMinor: 6700,
          acceptedAt: '2026-09-23T08:00:00.000Z',
          address: HOME,
        },
      };
      replies['GET /masters/me/jobs/current'] = { body: job };
      replies[`GET /orders/${ORDER_ID}/conversation`] = { body: conversation({ unreadCount: 2 }) };
      const onOpenConversation = jest.fn();
      await mountLive(
        <JobDetail onBack={jest.fn()} onOpenConversation={onOpenConversation} />,
        'master',
      );

      const entry = await screen.findByRole('button', {
        name: `${copy.entry.title}, ${copy.unread(2)}`,
      });
      expect(screen.getByText(copy.entry.open.master)).toBeOnTheScreen();

      await publishMessage('m-5');
      expect(
        await screen.findByRole('button', { name: `${copy.entry.title}, ${copy.unread(3)}` }),
      ).toBeOnTheScreen();

      await act(async () => {
        await fireEvent.press(entry);
        await Promise.resolve();
      });
      expect(onOpenConversation).toHaveBeenCalledWith(ORDER_ID);
    });
  });
});
