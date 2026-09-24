import type {
  Address,
  Conversation as ConversationContract,
  CurrentMasterJob,
  OrderStatus,
  OrderSummary,
} from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { Conversation } from '../conversation/Conversation';
import { CONVERSATION_COPY } from '../conversation/conversation-copy';
import { JobDetail } from '../master-jobs/JobDetail';
import { OrderDetail } from '../orders/OrderDetail';
import { ORDERS_COPY } from '../orders/orders-copy';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { signedIn } from '../store/session-slice';

import { CALL_COPY as copy } from './call-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
let mockCallingEnabled = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('./calling-enabled', () => ({
  get CALLING_ENABLED() {
    return mockCallingEnabled;
  },
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

function order(status: OrderStatus): OrderSummary {
  return {
    id: ORDER_ID,
    status,
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
  };
}

function conversation(writable: boolean): ConversationContract {
  return {
    id: 'conversation-1',
    orderId: ORDER_ID,
    unreadCount: 0,
    writable,
    createdAt: '2026-09-23T08:00:00.000Z',
    closedAt: writable ? null : '2026-09-23T09:00:00.000Z',
  };
}

let replies: Record<string, unknown> = {};

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const body = replies[`${request.method} ${url.pathname}`];
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'NOT_FOUND', message: '' } }), {
        status: body === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

async function mount(children: React.ReactNode, role: 'customer' | 'master'): Promise<void> {
  installTransport();
  const sockets = createFakeSocketFactory();
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

beforeEach(() => {
  mockPush.mockReset();
  mockCallingEnabled = true;
  replies = {
    [`GET /orders/${ORDER_ID}/photos`]: [],
    'GET /addresses': [HOME],
    'GET /services/svc-1': { id: 'svc-1', name: 'Santexnik' },
    [`GET /orders/${ORDER_ID}/messages`]: { items: [], nextCursor: null },
  };
});

const OUTGOING = { pathname: '/call/outgoing/[orderId]', params: { orderId: ORDER_ID } };

/**
 * The call entry point where ADR-0040 § 6 puts it — the customer's order
 * screen, the master's job and the conversation header — present only while
 * the order can be called about and calling is switched on.
 */
describe('the call entry point', () => {
  describe('on the customer’s order screen', () => {
    it('is there on an active order, and opens the outgoing call', async () => {
      replies[`GET /orders/${ORDER_ID}`] = order('MASTER_ON_THE_WAY');
      await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');

      await fireEvent.press(await screen.findByRole('button', { name: copy.entry.customer }));

      expect(mockPush).toHaveBeenCalledWith(OUTGOING);
    });

    it('is gone once the order is terminal', async () => {
      replies[`GET /orders/${ORDER_ID}`] = order('COMPLETED');
      await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');

      await screen.findByText(ORDERS_COPY.detail.problem);
      expect(screen.queryByRole('button', { name: copy.entry.customer })).toBeNull();
    });

    it('is not there at all while calling ships dark', async () => {
      mockCallingEnabled = false;
      replies[`GET /orders/${ORDER_ID}`] = order('IN_PROGRESS');
      await mount(<OrderDetail orderId={ORDER_ID} onBack={jest.fn()} />, 'customer');

      await screen.findByText(ORDERS_COPY.detail.problem);
      expect(screen.queryByRole('button', { name: copy.entry.customer })).toBeNull();
    });
  });

  describe('on the master’s job screen', () => {
    function job(status: OrderStatus): CurrentMasterJob {
      return {
        job: {
          orderId: ORDER_ID,
          offerId: 'offer-1',
          customerRating: { ratingAverage: null, ratingCount: 0 },
          status,
          serviceId: 'svc-1',
          description: 'Mətbəxdə kran sızır.',
          priceMinor: 6700,
          acceptedAt: '2026-09-23T08:00:00.000Z',
          address: HOME,
        },
      };
    }

    it('is there on the job, and opens the outgoing call', async () => {
      replies['GET /masters/me/jobs/current'] = job('MASTER_ARRIVED');
      await mount(<JobDetail onBack={jest.fn()} />, 'master');

      await fireEvent.press(await screen.findByRole('button', { name: copy.entry.master }));

      expect(mockPush).toHaveBeenCalledWith(OUTGOING);
    });

    it('is not there while calling ships dark', async () => {
      mockCallingEnabled = false;
      replies['GET /masters/me/jobs/current'] = job('MASTER_ARRIVED');
      await mount(<JobDetail onBack={jest.fn()} />, 'master');

      await screen.findByText('Mətbəxdə kran sızır.');
      expect(screen.queryByRole('button', { name: copy.entry.master })).toBeNull();
    });
  });

  describe('in the conversation header', () => {
    it('is there while the conversation is open, for either side', async () => {
      replies[`GET /orders/${ORDER_ID}/conversation`] = conversation(true);
      await mount(<Conversation orderId={ORDER_ID} viewer="master" onBack={jest.fn()} />, 'master');

      await fireEvent.press(await screen.findByRole('button', { name: copy.entry.master }));

      expect(mockPush).toHaveBeenCalledWith(OUTGOING);
    });

    it('is gone once the conversation is closed', async () => {
      replies[`GET /orders/${ORDER_ID}/conversation`] = conversation(false);
      await mount(
        <Conversation orderId={ORDER_ID} viewer="customer" onBack={jest.fn()} />,
        'customer',
      );

      await screen.findByText(CONVERSATION_COPY.closedNotice);
      expect(screen.queryByRole('button', { name: copy.entry.customer })).toBeNull();
    });
  });
});
