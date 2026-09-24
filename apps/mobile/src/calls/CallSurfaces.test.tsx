import type { Call } from '@tezusta/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocket, FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';

import { CALL_COPY as copy } from './call-copy';
import { FIXTURE_CALL_ID, FIXTURE_ORDER_ID, fixtureCall } from './call-fixtures';
import { IncomingCallRoute, OutgoingCallRoute } from './CallRoutes';
import {
  ringingCallReceived,
  selectCallSurfaceLive,
  selectRingingCall,
} from './ringing-call-slice';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** The microphone prompt, answered by each test — never by the platform. */
const mockMicrophone = jest.fn<Promise<{ granted: boolean }>, []>();

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: () => mockMicrophone(),
}));

const SERVICE_ID = 'service-1';

/** The order and its service, so the screen can name what the call is about. */
function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    if (pathname === `/orders/${FIXTURE_ORDER_ID}`) {
      return json({ id: FIXTURE_ORDER_ID, serviceId: SERVICE_ID });
    }
    if (pathname === `/services/${SERVICE_ID}`) {
      return json({ id: SERVICE_ID, name: 'Santexnik' });
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

interface Mounted {
  readonly store: AppStore;
  readonly socket: FakeSocket;
  readonly onClose: jest.Mock;
  sent(name: string): unknown[];
  frame(name: string, payload: Call): Promise<void>;
}

/**
 * Mounts a call route under the app's real store and connection, with a fake
 * transport beneath it — so a tap travels the production path: screen → hook →
 * reducer → socket request.
 */
async function mount(
  element: (onClose: jest.Mock) => React.ReactElement,
  options: { readonly ringing?: Call; readonly script?: (socket: FakeSocket) => void } = {},
): Promise<Mounted> {
  installTransport();
  const sockets: FakeSocketFactory = createFakeSocketFactory();
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
  if (options.ringing !== undefined) {
    store.dispatch(ringingCallReceived(options.ringing));
  }
  const onClose = jest.fn();

  const factory: FakeSocketFactory['factory'] = (socketOptions) => {
    const socket = sockets.factory(socketOptions);
    options.script?.(sockets.latest());
    return socket;
  };

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(connectionOptions) =>
          createRealtimeConnection({ ...connectionOptions, createSocket: factory })
        }
      >
        {element(onClose)}
      </RealtimeProvider>
    </Provider>,
  );

  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  const socket = sockets.latest();
  return {
    store,
    socket,
    onClose,
    sent: (name) =>
      socket.emitted.filter(({ event }) => event === name).map(({ payload }) => payload),
    frame: (name, payload) =>
      actAndSettle(() => {
        socket.serverEmit(name, { call: payload, at: 1 });
      }),
  };
}

beforeEach(() => {
  mockMicrophone.mockReset();
});

/**
 * Holds the microphone prompt open until the test answers it — after the
 * socket is up, which is where a person tapping "call" on an open order finds
 * it. Answered before the connection exists, the invite would be refused for
 * want of a socket, which is a different test.
 */
function heldMicrophone(): (granted: boolean) => Promise<void> {
  let answer: (value: { granted: boolean }) => void = () => undefined;
  mockMicrophone.mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  return async (granted) => {
    await act(async () => {
      answer({ granted });
      await Promise.resolve();
    });
  };
}

describe('placing a call', () => {
  function ringing(socket: FakeSocket): void {
    socket.answer('call:invite', () => ({
      ok: true,
      call: fixtureCall('RINGING', { role: 'caller' }),
    }));
    socket.answer('call:cancel', () => ({
      ok: true,
      call: fixtureCall('CANCELLED', { role: 'caller' }),
    }));
  }

  function outgoing(onClose: jest.Mock): React.ReactElement {
    return <OutgoingCallRoute orderId={FIXTURE_ORDER_ID} onClose={onClose} />;
  }

  it('asks for the microphone, then rings the other party, named by the server', async () => {
    const answer = heldMicrophone();
    const mounted = await mount(outgoing, { script: ringing });
    await answer(true);

    expect(await screen.findByText(copy.status.outgoing)).toBeOnTheScreen();
    expect(await screen.findByText('Elvin Məmmədov')).toBeOnTheScreen();
    expect(await screen.findByText('Santexnik')).toBeOnTheScreen();
    expect(mockMicrophone).toHaveBeenCalledTimes(1);
    expect(mounted.sent('call:invite')).toEqual([{ orderId: FIXTURE_ORDER_ID }]);
  });

  it('names the other party by their side of the order until the server has', async () => {
    heldMicrophone();
    await mount(outgoing, { script: ringing });

    expect(screen.getByText(copy.peerFallback.master)).toBeOnTheScreen();
    expect(screen.getByText(copy.status.permissions)).toBeOnTheScreen();
  });

  it('ends as permission_denied when the microphone is refused, and never invites', async () => {
    const answer = heldMicrophone();
    const mounted = await mount(outgoing, { script: ringing });
    await answer(false);

    expect(await screen.findByText(copy.ended.permission_denied)).toBeOnTheScreen();
    expect(mounted.sent('call:invite')).toEqual([]);
    expect(mounted.socket.emitted.filter(({ event }) => event.startsWith('call:'))).toEqual([]);
  });

  it('cancelling a ringing call ends it on the server too, and the screen stays until closed', async () => {
    const answer = heldMicrophone();
    const mounted = await mount(outgoing, { script: ringing });
    await answer(true);
    await screen.findByText(copy.status.outgoing);
    await waitFor(() => {
      expect(mounted.sent('call:invite')).toHaveLength(1);
    });

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.cancel }));

    expect(await screen.findByText(copy.ended.cancelled)).toBeOnTheScreen();
    await waitFor(() => {
      expect(mounted.sent('call:cancel')).toEqual([{ callId: FIXTURE_CALL_ID }]);
    });
    expect(mounted.onClose).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.close }));
    expect(mounted.onClose).toHaveBeenCalledTimes(1);
  });

  it('tells the root it holds a live call, and stops once the call is over', async () => {
    const answer = heldMicrophone();
    const mounted = await mount(outgoing, { script: ringing });
    await answer(true);
    await screen.findByText(copy.status.outgoing);

    expect(selectCallSurfaceLive(mounted.store.getState())).toBe(true);

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.cancel }));
    await screen.findByText(copy.ended.cancelled);

    expect(selectCallSurfaceLive(mounted.store.getState())).toBe(false);
  });
});

describe('a call ringing this phone', () => {
  const RINGING = fixtureCall('RINGING');

  function answering(socket: FakeSocket): void {
    socket.answer('call:accept', () => ({
      ok: true,
      call: fixtureCall('ACCEPTED'),
      credential: {
        callId: FIXTURE_CALL_ID,
        token: 'room-token',
        url: 'wss://media.example.test',
        expiresAt: '2026-09-24T10:10:00.000Z',
        identity: 'customer:1',
        peerIdentity: 'master:9',
      },
    }));
    socket.answer('call:reject', () => ({ ok: true, call: fixtureCall('REJECTED') }));
  }

  function incoming(onClose: jest.Mock): React.ReactElement {
    return <IncomingCallRoute callId={FIXTURE_CALL_ID} onClose={onClose} />;
  }

  it('shows the caller and asks nothing on arrival', async () => {
    await mount(incoming, { ringing: RINGING, script: answering });

    expect(screen.getByText('Elvin Məmmədov')).toBeOnTheScreen();
    expect(screen.getByText(copy.status.incoming)).toBeOnTheScreen();
    expect(mockMicrophone).not.toHaveBeenCalled();
  });

  it('on accept, asks for the microphone and then answers', async () => {
    const answer = heldMicrophone();
    const mounted = await mount(incoming, { ringing: RINGING, script: answering });

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.accept }));
    expect(mockMicrophone).toHaveBeenCalledTimes(1);
    expect(mounted.sent('call:accept')).toEqual([]);

    await answer(true);

    expect(await screen.findByText(copy.status.connecting)).toBeOnTheScreen();
    await waitFor(() => {
      expect(mounted.sent('call:accept')).toEqual([{ callId: FIXTURE_CALL_ID }]);
    });
  });

  it('refusing the microphone ends the call, declines it on the server, and never answers', async () => {
    mockMicrophone.mockResolvedValue({ granted: false });
    const mounted = await mount(incoming, { ringing: RINGING, script: answering });

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.accept }));

    expect(await screen.findByText(copy.ended.permission_denied)).toBeOnTheScreen();
    expect(mounted.sent('call:accept')).toEqual([]);
    await waitFor(() => {
      expect(mounted.sent('call:reject')).toEqual([{ callId: FIXTURE_CALL_ID }]);
    });
  });

  it('declining needs no microphone', async () => {
    const mounted = await mount(incoming, { ringing: RINGING, script: answering });

    await fireEvent.press(screen.getByRole('button', { name: copy.controls.decline }));

    expect(await screen.findByText(copy.ended.declined)).toBeOnTheScreen();
    expect(mockMicrophone).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mounted.sent('call:reject')).toEqual([{ callId: FIXTURE_CALL_ID }]);
    });
  });

  it('lets go of the ring once the call is over, and keeps saying why until closed', async () => {
    const mounted = await mount(incoming, { ringing: RINGING, script: answering });

    await mounted.frame('call:cancelled', fixtureCall('CANCELLED'));

    expect(await screen.findByText(copy.ended.cancelled)).toBeOnTheScreen();
    expect(selectRingingCall(mounted.store.getState())).toBeNull();
    expect(selectCallSurfaceLive(mounted.store.getState())).toBe(false);
    expect(mounted.onClose).not.toHaveBeenCalled();
  });

  it('closes straight away when there is no such ring', async () => {
    const mounted = await mount(incoming);

    await waitFor(() => {
      expect(mounted.onClose).toHaveBeenCalled();
    });
    expect(screen.queryByText(copy.status.incoming)).toBeNull();
  });
});
