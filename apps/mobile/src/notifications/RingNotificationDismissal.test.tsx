import type { Call, CallStatus } from '@tezusta/types';
import { render } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { signedIn } from '../store/session-slice';

import { RingNotificationDismissal } from './RingNotificationDismissal';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** Every call id whose ring notification was taken down. */
const mockDismissed: string[] = [];
jest.mock('./push-adapter', () => ({
  dismissCallNotifications: (callId: string) => {
    mockDismissed.push(callId);
    return Promise.resolve();
  },
}));

function call(status: CallStatus, id = 'call-7'): Call {
  return {
    id,
    orderId: 'order-1',
    status,
    endReason: null,
    role: 'callee',
    peer: { kind: 'master', displayName: 'Elvin' },
    startedAt: '2026-09-24T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
  };
}

async function mount(): Promise<(name: string, payload: Call) => Promise<void>> {
  const sockets: FakeSocketFactory = createFakeSocketFactory();
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        <RingNotificationDismissal />
      </RealtimeProvider>
    </Provider>,
  );
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  return (name, payload) =>
    actAndSettle(() => {
      sockets.latest().serverEmit(name, { call: payload, at: 1 });
    });
}

beforeEach(() => {
  mockDismissed.length = 0;
});

/**
 * A delivered push cannot be retracted by the server, so the phone takes the
 * ring notification down itself the moment a frame says the call is over
 * (ADR-0039 § 6, #189) — for any call id, shown on screen or not.
 */
describe('RingNotificationDismissal', () => {
  it.each([
    ['call:cancelled', 'CANCELLED'],
    ['call:timeout', 'TIMED_OUT'],
    ['call:rejected', 'REJECTED'],
    ['call:busy', 'BUSY'],
    ['call:accepted', 'ACCEPTED'],
    ['call:ended', 'ENDED'],
  ] as const)('takes the ring down on %s', async (name, status) => {
    const frame = await mount();

    await frame(name, call(status));

    expect(mockDismissed).toEqual(['call-7']);
  });

  it('leaves it up while the call is still ringing', async () => {
    const frame = await mount();

    await frame('call:incoming', call('RINGING'));

    expect(mockDismissed).toEqual([]);
  });
});
