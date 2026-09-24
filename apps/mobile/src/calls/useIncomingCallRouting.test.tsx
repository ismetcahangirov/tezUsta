import type { Call } from '@tezusta/types';
import { render } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';

import { fixtureCall } from './call-fixtures';
import { callSurfaceLive, ringingCallCleared, selectRingingCall } from './ringing-call-slice';
import { IncomingCallListener } from './useIncomingCallRouting';

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

beforeEach(() => {
  mockPush.mockReset();
  mockCallingEnabled = true;
});

async function mount(): Promise<{ store: AppStore; ring: (call: Call) => Promise<void> }> {
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
        <IncomingCallListener />
      </RealtimeProvider>
    </Provider>,
  );
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  return {
    store,
    ring: (call) =>
      actAndSettle(() => {
        sockets.latest().serverEmit('call:incoming', { call, at: 1 });
      }),
  };
}

describe('the root ring listener', () => {
  it('holds the ringing call and presents the incoming screen for it', async () => {
    const { store, ring } = await mount();
    const call = fixtureCall('RINGING');

    await ring(call);

    expect(selectRingingCall(store.getState())).toEqual(call);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/call/incoming/[callId]',
      params: { callId: call.id },
    });
  });

  it('ignores a ring while a call screen holds a live call', async () => {
    const { store, ring } = await mount();
    await actAndSettle(() => {
      store.dispatch(callSurfaceLive(true));
    });

    await ring(fixtureCall('RINGING', { id: 'call-2' }));

    expect(selectRingingCall(store.getState())).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not present the same ring twice', async () => {
    const { ring } = await mount();

    await ring(fixtureCall('RINGING'));
    await ring(fixtureCall('RINGING'));

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('rings again once the previous call is over', async () => {
    const { store, ring } = await mount();
    await ring(fixtureCall('RINGING'));
    await actAndSettle(() => {
      store.dispatch(ringingCallCleared('call-1'));
    });

    await ring(fixtureCall('RINGING', { id: 'call-2' }));

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(selectRingingCall(store.getState())?.id).toBe('call-2');
  });

  it('ignores a frame about a call this phone placed', async () => {
    const { ring } = await mount();

    await ring(fixtureCall('RINGING', { role: 'caller' }));

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ignores every ring while calling ships dark', async () => {
    mockCallingEnabled = false;
    const { store, ring } = await mount();

    await ring(fixtureCall('RINGING'));

    expect(selectRingingCall(store.getState())).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
