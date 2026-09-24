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
import { callSurfaceShown, ringingCallCleared, selectRingingCall } from './ringing-call-slice';
import { IncomingCallListener } from './useIncomingCallRouting';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockCallingEnabled = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock('./calling-enabled', () => ({
  get CALLING_ENABLED() {
    return mockCallingEnabled;
  },
}));

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockCallingEnabled = true;
});

interface Mounted {
  readonly store: AppStore;
  readonly ring: (call: Call) => Promise<void>;
  readonly frame: (name: string, call: Call) => Promise<void>;
}

async function mount(): Promise<Mounted> {
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
    frame: (name, call) =>
      actAndSettle(() => {
        sockets.latest().serverEmit(name, { call, at: 2 });
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
      store.dispatch(callSurfaceShown({ token: 'screen-1', live: true }));
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

  it('replaces an ended call screen that is still open instead of stacking over it', async () => {
    const { store, ring } = await mount();
    await actAndSettle(() => {
      store.dispatch(callSurfaceShown({ token: 'screen-1', live: false }));
    });

    await ring(fixtureCall('RINGING', { id: 'call-2' }));

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/call/incoming/[callId]',
      params: { callId: 'call-2' },
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('lets go of the ring when presenting it throws, so the next ring is not blocked', async () => {
    const { store, ring } = await mount();
    mockPush.mockImplementationOnce(() => {
      throw new Error('no navigator');
    });

    await ring(fixtureCall('RINGING'));
    expect(selectRingingCall(store.getState())).toBeNull();

    await ring(fixtureCall('RINGING', { id: 'call-2' }));
    expect(selectRingingCall(store.getState())?.id).toBe('call-2');
  });

  it.each([
    ['call:cancelled', 'CANCELLED'],
    ['call:timeout', 'TIMED_OUT'],
    ['call:accepted', 'ACCEPTED'],
  ] as const)('lets go of the ring on %s, even with no screen showing it', async (name, status) => {
    const { store, ring, frame } = await mount();
    await ring(fixtureCall('RINGING'));

    await frame(name, fixtureCall(status));

    expect(selectRingingCall(store.getState())).toBeNull();
  });

  it('keeps the ring when a frame is about another call', async () => {
    const { store, ring, frame } = await mount();
    await ring(fixtureCall('RINGING'));

    await frame('call:cancelled', fixtureCall('CANCELLED', { id: 'call-9' }));

    expect(selectRingingCall(store.getState())?.id).toBe('call-1');
  });
});
