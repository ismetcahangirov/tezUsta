import type { Call, CallJoinCredential, CallStatus } from '@tezusta/types';
import { act, render, waitFor } from '@testing-library/react-native';
import { StrictMode, useState } from 'react';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocket, FakeSocketFactory } from '../../test/support/fake-socket';
import { createTestStore } from '../../test/support/test-store';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import type { AppStore } from '../store';
import { signedIn } from '../store/session-slice';

import { useIncomingCall, useOutgoingCall } from './useCall';
import type { IncomingCall, OutgoingCall } from './useCall';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const CALL_ID = 'call-1';

function call(status: CallStatus, overrides: Partial<Call> = {}): Call {
  return {
    id: CALL_ID,
    orderId: ORDER_ID,
    status,
    endReason: null,
    role: 'caller',
    peer: { kind: 'master', displayName: 'Elvin' },
    startedAt: '2026-09-24T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    ...overrides,
  };
}

const ENDED_BY_HANGUP = call('ENDED', {
  endReason: 'hangup',
  answeredAt: '2026-09-24T10:00:05.000Z',
  endedAt: '2026-09-24T10:01:00.000Z',
});

/** A bearer token no test output, store or log may ever contain. */
const SECRET = 'room-token-never-in-the-store';

function credential(token = SECRET): CallJoinCredential {
  return {
    callId: CALL_ID,
    token,
    url: 'wss://media.example.test',
    expiresAt: '2026-09-24T10:10:00.000Z',
    identity: 'customer:1',
    peerIdentity: 'master:9',
  };
}

let joinStatus = 200;
let joinRequests: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);

    if (url.pathname === `/calls/${CALL_ID}/join` && request.method === 'POST') {
      joinRequests.push(url.pathname);
      return Promise.resolve(
        new Response(
          JSON.stringify(joinStatus === 200 ? credential() : { code: 'FORBIDDEN', message: 'no' }),
          { status: joinStatus, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

interface Mounted<Result> {
  readonly result: { readonly current: Result };
  /** The screen holding the hook goes away — a hardware back, a torn-down navigator. */
  unmount(): Promise<void>;
  readonly store: AppStore;
  readonly socket: FakeSocket;
  /** Every call request this phone sent, as `name → payload`. */
  sent(name: string): unknown[];
  frame(name: string, payload: Call): Promise<void>;
}

/**
 * Lets the unmount's deferred tell run (`useCall.ts` defers it a tick so a
 * StrictMode remount can cancel it), and whatever it sent be answered.
 */
async function nextTick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await actAndSettle(() => undefined);
}

/** Hides the component holding the hook, leaving the store and the connection mounted. */
let hideProbe: () => void = () => undefined;

function ProbeGate({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const [shown, setShown] = useState(true);
  hideProbe = () => {
    setShown(false);
  };
  return shown ? children : null;
}

/**
 * Mounts a call hook under the app's real connection with a fake transport
 * beneath it, so every frame travels the production path: socket → connection
 * → subscription → id match → reducer.
 */
async function mount<Result>(
  hook: () => Result,
  script: (socket: FakeSocket) => void = () => undefined,
  options: { readonly strict?: boolean } = {},
): Promise<Mounted<Result>> {
  installTransport();
  const sockets: FakeSocketFactory = createFakeSocketFactory();
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

  // Scripted before anything renders: the invite goes out on the first
  // effect after the permission, and the connection must already be live.
  const factory: FakeSocketFactory['factory'] = (options) => {
    const socket = sockets.factory(options);
    script(sockets.latest());
    return socket;
  };

  const result = { current: undefined as unknown as Result };
  function HookProbe(): null {
    result.current = hook();
    return null;
  }

  const tree = (
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(connectionOptions) =>
          createRealtimeConnection({ ...connectionOptions, createSocket: factory })
        }
      >
        <ProbeGate>
          <HookProbe />
        </ProbeGate>
      </RealtimeProvider>
    </Provider>
  );
  // StrictMode at the root, where React applies its double mount to effects
  // — inside a `renderHook` wrapper it does not.
  await render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);

  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  const socket = sockets.latest();
  return {
    result,
    unmount: async () => {
      // Only the hook's screen goes, as in the app: the connection above it
      // is the root's and outlives every call screen.
      await actAndSettle(() => {
        hideProbe();
      });
      await nextTick();
    },
    store,
    socket,
    sent: (name) =>
      socket.emitted.filter(({ event }) => event === name).map(({ payload }) => payload),
    frame: (name, payload) =>
      actAndSettle(() => {
        socket.serverEmit(name, { call: payload, at: 1 });
      }),
  };
}

async function user(action: () => void): Promise<void> {
  await act(() => {
    action();
  });
}

beforeEach(() => {
  joinStatus = 200;
  joinRequests = [];
});

describe('an outgoing call', () => {
  function ringing(socket: FakeSocket): void {
    socket.answer('call:invite', () => ({ ok: true, call: call('RINGING') }));
    socket.answer('call:cancel', () => ({ ok: true, call: call('CANCELLED') }));
    socket.answer('call:hangup', () => ({ ok: true, call: ENDED_BY_HANGUP }));
  }

  async function placed(): Promise<Mounted<OutgoingCall>> {
    const mounted = await mount(() => useOutgoingCall(ORDER_ID), ringing);
    await user(() => mounted.result.current.permissionGranted());
    await waitFor(() => {
      expect(mounted.result.current.state).toEqual({
        phase: 'outgoing',
        orderId: ORDER_ID,
        callId: CALL_ID,
      });
    });
    return mounted;
  }

  it('invites on the order once the microphone is granted, and learns the call from the ack', async () => {
    const mounted = await placed();

    expect(mounted.sent('call:invite')).toEqual([{ orderId: ORDER_ID }]);
  });

  it('names the other party from the invite’s ack, and not before it', async () => {
    const mounted = await mount(() => useOutgoingCall(ORDER_ID), ringing);
    expect(mounted.result.current.peer).toBeNull();

    await user(() => mounted.result.current.permissionGranted());

    await waitFor(() => {
      expect(mounted.result.current.peer).toEqual({ kind: 'master', displayName: 'Elvin' });
    });
  });

  it('sends nothing when the microphone is refused', async () => {
    const mounted = await mount(() => useOutgoingCall(ORDER_ID), ringing);

    await user(() => mounted.result.current.permissionDenied());

    expect(mounted.result.current.state).toMatchObject({
      phase: 'ended',
      endReason: 'permission_denied',
    });
    expect(mounted.socket.emitted).toEqual([]);
  });

  it('on call:accepted, fetches its own credential and keeps it out of the store', async () => {
    const mounted = await placed();

    await mounted.frame('call:accepted', call('ACCEPTED'));

    await waitFor(() => {
      expect(mounted.result.current.credential).toEqual(credential());
    });
    expect(mounted.result.current.state.phase).toBe('connecting');
    expect(joinRequests).toEqual([`/calls/${CALL_ID}/join`]);
    expect(JSON.stringify(mounted.store.getState())).not.toContain(SECRET);
  });

  it('ignores a duplicated call:accepted — one credential request, one state', async () => {
    const mounted = await placed();
    await mounted.frame('call:accepted', call('ACCEPTED'));
    await waitFor(() => {
      expect(mounted.result.current.credential).not.toBeNull();
    });
    const before = mounted.result.current.state;

    await mounted.frame('call:accepted', call('ACCEPTED'));

    expect(mounted.result.current.state).toBe(before);
    expect(joinRequests).toHaveLength(1);
  });

  it('ignores frames about another call', async () => {
    const mounted = await placed();
    const before = mounted.result.current.state;

    await mounted.frame('call:accepted', { ...call('ACCEPTED'), id: 'call-2' });
    await mounted.frame('call:ended', { ...ENDED_BY_HANGUP, id: 'call-2' });

    expect(mounted.result.current.state).toBe(before);
  });

  it('ends on call:ended with no room event at all, drops the credential, and does not echo a hangup', async () => {
    const mounted = await placed();
    await mounted.frame('call:accepted', call('ACCEPTED'));
    await waitFor(() => {
      expect(mounted.result.current.credential).not.toBeNull();
    });
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));

    await mounted.frame('call:ended', ENDED_BY_HANGUP);

    expect(mounted.result.current.state).toMatchObject({
      phase: 'ended',
      endReason: 'completed',
      connectedAt: 5_000,
    });
    expect(mounted.result.current.credential).toBeNull();
    expect(mounted.sent('call:hangup')).toEqual([]);
  });

  it('stays active through a transient disconnect and the reconnect after it', async () => {
    const mounted = await placed();
    await mounted.frame('call:accepted', call('ACCEPTED'));
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));
    await user(() => mounted.result.current.roomEvent({ type: 'remote-joined' }));
    const active = mounted.result.current.state;

    await user(() => mounted.result.current.roomEvent({ type: 'room-reconnecting' }));
    expect(mounted.result.current.state.phase).toBe('reconnecting');
    await user(() => mounted.result.current.roomEvent({ type: 'room-reconnected' }));

    expect(mounted.result.current.state).toEqual(active);
    expect(mounted.sent('call:hangup')).toEqual([]);
  });

  it('cancels a ringing call on the server', async () => {
    const mounted = await placed();

    await user(() => mounted.result.current.cancel());

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'cancelled' });
    await waitFor(() => {
      expect(mounted.sent('call:cancel')).toEqual([{ callId: CALL_ID }]);
    });
  });

  it('cancels the ring the server started when the caller gave up before the invite was answered', async () => {
    const mounted = await mount(
      () => useOutgoingCall(ORDER_ID),
      (socket) => {
        ringing(socket);
        // Held back until the test releases it, as a slow server would.
        socket.answer('call:invite', null);
      },
    );

    await user(() => mounted.result.current.permissionGranted());
    await waitFor(() => {
      expect(mounted.sent('call:invite')).toHaveLength(1);
    });
    await user(() => mounted.result.current.cancel());
    expect(mounted.sent('call:cancel')).toEqual([]);
    await actAndSettle(() => {
      mounted.socket.release('call:invite', { ok: true, call: call('RINGING') });
    });

    await waitFor(() => {
      expect(mounted.sent('call:cancel')).toEqual([{ callId: CALL_ID }]);
    });
    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'cancelled' });
  });

  it('ends as busy when the invite was recorded busy, and tells the server nothing more', async () => {
    const mounted = await mount(
      () => useOutgoingCall(ORDER_ID),
      (socket) => {
        socket.answer('call:invite', () => ({
          ok: true,
          call: call('BUSY', { endReason: 'busy', endedAt: '2026-09-24T10:00:00.000Z' }),
        }));
      },
    );

    await user(() => mounted.result.current.permissionGranted());

    await waitFor(() => {
      expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'busy' });
    });
    expect(mounted.sent('call:cancel')).toEqual([]);
  });

  it('ends as an error when the invite is refused', async () => {
    const mounted = await mount(
      () => useOutgoingCall(ORDER_ID),
      (socket) => {
        socket.answer('call:invite', () => ({
          ok: false,
          code: 'CALL_RATE_LIMITED',
          message: 'Too many calls.',
        }));
      },
    );

    await user(() => mounted.result.current.permissionGranted());

    await waitFor(() => {
      expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'error' });
    });
  });

  it('ends as connect_failed when no credential can be had, and hangs up the answered call', async () => {
    joinStatus = 403;
    const mounted = await placed();

    await mounted.frame('call:accepted', call('ACCEPTED'));

    await waitFor(() => {
      expect(mounted.result.current.state).toMatchObject({
        phase: 'ended',
        endReason: 'connect_failed',
      });
    });
    await waitFor(() => {
      expect(mounted.sent('call:hangup')).toEqual([{ callId: CALL_ID }]);
    });
  });

  it('hangs up on the server when the user hangs up', async () => {
    const mounted = await placed();
    await mounted.frame('call:accepted', call('ACCEPTED'));
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));

    await user(() => mounted.result.current.hangup());

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'completed' });
    await waitFor(() => {
      expect(mounted.sent('call:hangup')).toEqual([{ callId: CALL_ID }]);
    });
  });

  it('hangs up on the server when the room is lost for good', async () => {
    const mounted = await placed();
    await mounted.frame('call:accepted', call('ACCEPTED'));
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));

    await user(() => mounted.result.current.roomEvent({ type: 'room-disconnected' }));

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'dropped' });
    await waitFor(() => {
      expect(mounted.sent('call:hangup')).toEqual([{ callId: CALL_ID }]);
    });
  });
});

describe('an incoming call', () => {
  const RINGING = call('RINGING', { role: 'callee' });

  function answering(socket: FakeSocket): void {
    socket.answer('call:accept', () => ({
      ok: true,
      call: call('ACCEPTED', { role: 'callee' }),
      credential: credential(),
    }));
    socket.answer('call:reject', () => ({ ok: true, call: call('REJECTED') }));
  }

  async function ringingHere(
    script: (socket: FakeSocket) => void = answering,
  ): Promise<Mounted<IncomingCall>> {
    const mounted = await mount(() => useIncomingCall(RINGING), script);
    expect(mounted.result.current.state).toEqual({
      phase: 'incoming',
      orderId: ORDER_ID,
      callId: CALL_ID,
    });
    return mounted;
  }

  it('accepts over the socket and takes its credential from the ack, not the store', async () => {
    const mounted = await ringingHere();

    await user(() => mounted.result.current.accept());

    await waitFor(() => {
      expect(mounted.result.current.credential).toEqual(credential());
    });
    expect(mounted.sent('call:accept')).toEqual([{ callId: CALL_ID }]);
    expect(joinRequests).toEqual([]);
    expect(JSON.stringify(mounted.store.getState())).not.toContain(SECRET);
  });

  it('fetches the credential when the accept landed but the credential could not be minted', async () => {
    const mounted = await ringingHere((socket) => {
      socket.answer('call:accept', () => ({
        ok: false,
        code: 'CALL_UNAVAILABLE',
        message: 'The call could not be completed right now.',
        call: call('ACCEPTED', { role: 'callee' }),
      }));
    });

    await user(() => mounted.result.current.accept());

    await waitFor(() => {
      expect(mounted.result.current.credential).toEqual(credential());
    });
    expect(mounted.result.current.state.phase).toBe('connecting');
    expect(joinRequests).toEqual([`/calls/${CALL_ID}/join`]);
  });

  it('declines over the socket', async () => {
    const mounted = await ringingHere();

    await user(() => mounted.result.current.decline());

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'declined' });
    await waitFor(() => {
      expect(mounted.sent('call:reject')).toEqual([{ callId: CALL_ID }]);
    });
  });

  it('stops ringing, without declining, when another of this account’s phones answers', async () => {
    const mounted = await ringingHere();

    await mounted.frame('call:accepted', call('ACCEPTED', { role: 'callee' }));

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'completed' });
    expect(mounted.sent('call:reject')).toEqual([]);
  });

  it('stops ringing when the caller cancels', async () => {
    const mounted = await ringingHere();

    await mounted.frame('call:cancelled', call('CANCELLED', { endReason: 'cancelled' }));

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'cancelled' });
    expect(mounted.socket.emitted).toEqual([]);
  });

  it('does not hang up a call another phone answered first', async () => {
    const mounted = await ringingHere((socket) => {
      socket.answer('call:accept', () => ({
        ok: false,
        code: 'CALL_STALE',
        message: 'The call has already moved on.',
        call: call('ACCEPTED', { role: 'callee' }),
      }));
    });

    await user(() => mounted.result.current.accept());

    await waitFor(() => {
      expect(mounted.result.current.state).toMatchObject({
        phase: 'ended',
        endReason: 'completed',
      });
    });
    expect(mounted.sent('call:hangup')).toEqual([]);
  });

  it('ends a held call on the server’s word even with the room still up', async () => {
    const mounted = await ringingHere();
    await user(() => mounted.result.current.accept());
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));

    await mounted.frame('call:ended', { ...ENDED_BY_HANGUP, endReason: 'reaped' });

    expect(mounted.result.current.state).toMatchObject({ phase: 'ended', endReason: 'dropped' });
    expect(mounted.sent('call:hangup')).toEqual([]);
  });
});

/**
 * The safety net under the screen's hold on the hardware back (#188 review,
 * item 3): a screen that goes away mid-call tells the server once, by how far
 * the call had got, and a call that was already over tells it nothing more.
 */
describe('a call whose screen goes away before it is over', () => {
  function everything(socket: FakeSocket): void {
    socket.answer('call:invite', () => ({ ok: true, call: call('RINGING') }));
    socket.answer('call:cancel', () => ({ ok: true, call: call('CANCELLED') }));
    socket.answer('call:reject', () => ({ ok: true, call: call('REJECTED') }));
    socket.answer('call:hangup', () => ({ ok: true, call: ENDED_BY_HANGUP }));
    socket.answer('call:accept', () => ({
      ok: true,
      call: call('ACCEPTED', { role: 'callee' }),
      credential: credential(),
    }));
  }

  it('cancels a ringing outgoing call, once', async () => {
    const mounted = await mount(() => useOutgoingCall(ORDER_ID), everything);
    await user(() => mounted.result.current.permissionGranted());
    await waitFor(() => {
      expect(mounted.result.current.state.callId).toBe(CALL_ID);
    });

    await mounted.unmount();

    expect(mounted.sent('call:cancel')).toEqual([{ callId: CALL_ID }]);
    expect(mounted.sent('call:hangup')).toEqual([]);
  });

  it('cancels the ring an in-flight invite starts after the screen has gone', async () => {
    const mounted = await mount(
      () => useOutgoingCall(ORDER_ID),
      (socket) => {
        everything(socket);
        socket.answer('call:invite', null);
      },
    );
    await user(() => mounted.result.current.permissionGranted());
    await waitFor(() => {
      expect(mounted.sent('call:invite')).toHaveLength(1);
    });

    await mounted.unmount();
    await actAndSettle(() => {
      mounted.socket.release('call:invite', { ok: true, call: call('RINGING') });
    });

    expect(mounted.sent('call:cancel')).toEqual([{ callId: CALL_ID }]);
  });

  it('rejects a ringing incoming call', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
    );

    await mounted.unmount();

    expect(mounted.sent('call:reject')).toEqual([{ callId: CALL_ID }]);
  });

  it('hangs up a call that was answered', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
    );
    await user(() => mounted.result.current.accept());
    await user(() => mounted.result.current.roomEvent({ type: 'room-connected', at: 5_000 }));

    await mounted.unmount();

    expect(mounted.sent('call:hangup')).toEqual([{ callId: CALL_ID }]);
    expect(mounted.sent('call:reject')).toEqual([]);
  });

  it('says nothing more about a call that was already over', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
    );
    await user(() => mounted.result.current.decline());
    await waitFor(() => {
      expect(mounted.sent('call:reject')).toHaveLength(1);
    });

    await mounted.unmount();

    expect(mounted.sent('call:reject')).toHaveLength(1);
    expect(mounted.sent('call:hangup')).toEqual([]);
  });

  it('sends nothing for a call that never left the microphone question', async () => {
    const mounted = await mount(() => useOutgoingCall(ORDER_ID), everything);

    await mounted.unmount();

    expect(mounted.socket.emitted.filter(({ event }) => event.startsWith('call:'))).toEqual([]);
  });
});

/**
 * StrictMode and Fast Refresh unmount and remount the same component in
 * development. The unmount's tell is deferred and cancelled by the remount, so
 * a call on screen is never ended by it — and a real end later is still told.
 */
describe('a call under StrictMode', () => {
  function everything(socket: FakeSocket): void {
    socket.answer('call:reject', () => ({ ok: true, call: call('REJECTED') }));
    socket.answer('call:accept', () => ({
      ok: true,
      call: call('ACCEPTED', { role: 'callee' }),
      credential: credential(),
    }));
    socket.answer('call:hangup', () => ({ ok: true, call: ENDED_BY_HANGUP }));
  }

  it('sends no call request just for mounting', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
      { strict: true },
    );
    await nextTick();

    expect(mounted.socket.emitted.filter(({ event }) => event.startsWith('call:'))).toEqual([]);
    expect(mounted.result.current.state.phase).toBe('incoming');
  });

  it('still tells the server about a real end, once', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
      { strict: true },
    );
    await nextTick();

    await user(() => mounted.result.current.decline());
    await nextTick();

    expect(mounted.sent('call:reject')).toEqual([{ callId: CALL_ID }]);
  });

  it('still tells the server when the screen really goes away', async () => {
    const mounted = await mount(
      () => useIncomingCall(call('RINGING', { role: 'callee' })),
      everything,
      { strict: true },
    );
    await nextTick();

    await mounted.unmount();

    expect(mounted.sent('call:reject')).toEqual([{ callId: CALL_ID }]);
  });
});
