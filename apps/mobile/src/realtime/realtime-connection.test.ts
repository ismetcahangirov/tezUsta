import type { OrderTransitionRealtimeEvent } from '@tezusta/types';

import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';

import type { ConnectionStatus } from './connection-slice';
import {
  CALL_ACK_TIMEOUT_MS,
  createRealtimeConnection,
  recoveryDelayMs,
} from './realtime-connection';
import type { RealtimeConnection, Recovery, SocketEnding } from './realtime-connection';
import type { RealtimeEvent } from './realtime-events';
import {
  CONVERSATION_TYPING_EVENT,
  ORDER_TRANSITION_EVENT,
  ROOM_JOIN,
  ROOM_LEAVE,
} from './realtime-events';

const TRANSITION: OrderTransitionRealtimeEvent = {
  orderId: 'order-1',
  status: 'ACCEPTED',
  masterId: 'master-1',
  priceMinor: 6700,
  at: 1_000,
};

interface Harness {
  readonly connection: RealtimeConnection;
  readonly sockets: FakeSocketFactory;
  readonly statuses: readonly ConnectionStatus[];
  readonly events: readonly RealtimeEvent[];
  /** Every ending `recover` was asked about, in order. */
  readonly endings: readonly SocketEnding[];
  resumes(): number;
  setToken(token: string | null): void;
  /** How `recover` answers from now on. Retries by default. */
  answerRecovery(
    answer: (ending: SocketEnding, presented: string | null) => Promise<Recovery>,
  ): void;
}

function harness(): Harness {
  const sockets = createFakeSocketFactory();
  const statuses: ConnectionStatus[] = [];
  const events: RealtimeEvent[] = [];
  const endings: SocketEnding[] = [];
  let resumed = 0;
  let token: string | null = 'token-1';
  let recovery: (ending: SocketEnding, presented: string | null) => Promise<Recovery> = () =>
    Promise.resolve('retry');

  const connection = createRealtimeConnection({
    getToken: () => token,
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    onResumed: () => {
      resumed += 1;
    },
    recover: (ending, presented) => {
      endings.push(ending);
      return recovery(ending, presented);
    },
    createSocket: sockets.factory,
    // The midpoint of the jitter, so every wait is exactly the curve's value.
    random: () => 0.5,
  });

  return {
    connection,
    sockets,
    statuses,
    events,
    endings,
    resumes: () => resumed,
    setToken: (next) => {
      token = next;
    },
    answerRecovery: (answer) => {
      recovery = answer;
    },
  };
}

/** Lets a resolved `recover` and the dial after it run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/**
 * The app's one socket, tested against a fake transport (issue #170).
 *
 * Every assertion here is about something a customer would notice: an order
 * screen that stops receiving after a tunnel, a screen that claims to be live
 * while the connection is gone, a second account inheriting the first one's
 * subscriptions.
 */
describe('the realtime connection', () => {
  it('reports connecting, then live, and delivers what the server publishes', () => {
    const app = harness();

    app.connection.open();
    expect(app.statuses).toEqual(['connecting']);

    app.sockets.latest().serverConnect();
    expect(app.statuses).toEqual(['connecting', 'live']);

    app.sockets.latest().serverEmit(ORDER_TRANSITION_EVENT, TRANSITION);
    expect(app.events).toEqual([{ name: 'order:transition', payload: TRANSITION }]);
  });

  it('opens one socket however many times it is asked', () => {
    const app = harness();

    app.connection.open();
    app.connection.open();

    expect(app.sockets.sockets).toHaveLength(1);
  });

  it('says reconnecting while the connection is gone, not offline', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();

    app.sockets.latest().serverDisconnect();

    expect(app.statuses.at(-1)).toBe('reconnecting');
  });

  /**
   * **The claim the whole file turns on.** A reconnect is a new connection on
   * the server, in no rooms at all. The screens do not unmount when a train
   * goes into a tunnel, so nothing would ever re-join if this did not.
   */
  it('re-joins every room it was listening to when the connection comes back', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    app.connection.join({ kind: 'order', orderId: 'order-1' });
    app.connection.join({ kind: 'master', masterId: 'master-9' });

    app.sockets.latest().serverDisconnect();
    app.sockets.latest().serverConnect();

    const joins = app.sockets
      .latest()
      .emitted.filter((message) => message.event === ROOM_JOIN)
      .map((message) => message.payload);
    expect(joins).toEqual([
      { kind: 'order', orderId: 'order-1' },
      { kind: 'master', masterId: 'master-9' },
      { kind: 'order', orderId: 'order-1' },
      { kind: 'master', masterId: 'master-9' },
    ]);
  });

  it('does not re-join a room the screen has left', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    app.connection.join({ kind: 'order', orderId: 'order-1' });
    app.connection.leave({ kind: 'order', orderId: 'order-1' });

    app.sockets.latest().serverDisconnect();
    app.sockets.latest().serverConnect();

    const afterLeave = app.sockets
      .latest()
      .emitted.slice(2)
      .filter((message) => message.event === ROOM_JOIN);
    expect(afterLeave).toEqual([]);
    expect(app.sockets.latest().emitted[1]?.event).toBe(ROOM_LEAVE);
  });

  /**
   * The order screen and the conversation pushed over it both want the order's
   * room (issue #182). Backing out of the conversation must not deafen the
   * order screen underneath it.
   */
  it('keeps a room while any screen still wants it, and leaves it with the last', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();

    app.connection.join({ kind: 'order', orderId: 'order-1' });
    app.connection.join({ kind: 'order', orderId: 'order-1' });
    app.connection.leave({ kind: 'order', orderId: 'order-1' });

    expect(app.sockets.latest().emitted.map((message) => message.event)).toEqual([ROOM_JOIN]);

    app.sockets.latest().serverDisconnect();
    app.sockets.latest().serverConnect();
    expect(app.sockets.latest().emitted.map((message) => message.event)).toEqual([
      ROOM_JOIN,
      ROOM_JOIN,
    ]);

    app.connection.leave({ kind: 'order', orderId: 'order-1' });
    expect(app.sockets.latest().emitted.at(-1)?.event).toBe(ROOM_LEAVE);
  });

  it('delivers the conversation’s frames and sends a typing signal', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();

    const typing = { orderId: 'order-1', at: 3_000 };
    app.sockets.latest().serverEmit(CONVERSATION_TYPING_EVENT, typing);
    expect(app.events).toEqual([{ name: 'conversation:typing', payload: typing }]);

    app.connection.signalTyping('order-1');
    expect(app.sockets.latest().emitted.at(-1)).toEqual({
      event: CONVERSATION_TYPING_EVENT,
      payload: { orderId: 'order-1' },
    });
  });

  it('refetches over HTTP after a gap, and not on the first connection', () => {
    const app = harness();

    app.connection.open();
    app.sockets.latest().serverConnect();
    expect(app.resumes()).toBe(0);

    app.sockets.latest().serverDisconnect();
    app.sockets.latest().serverConnect();
    expect(app.resumes()).toBe(1);
  });

  /**
   * A refused upgrade is usually an expired access token. socket.io reads
   * `auth` again on the next attempt, so the token the HTTP layer has since
   * rotated is the one presented — this asserts the connection reads it per
   * attempt rather than capturing it at construction.
   */
  it('presents the current token on every attempt, not the one it started with', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverRefuse();

    app.setToken('token-2');
    app.connection.close();
    app.connection.open();

    expect(app.sockets.sockets.at(0)?.tokensPresented).toEqual(['token-1']);
    expect(app.sockets.latest().tokensPresented).toEqual(['token-2']);
  });

  it('stays connecting, not reconnecting, when the first attempt is refused', () => {
    const app = harness();

    app.connection.open();
    app.sockets.latest().serverRefuse();

    expect(app.statuses.at(-1)).toBe('connecting');
    // The refusal scheduled a retry (#468); cancel it rather than let it fire
    // after the test.
    app.connection.close();
  });

  /**
   * Backgrounding. The screens stay mounted, so the rooms must survive — and
   * coming back counts as a reconnection, which is what makes the refetch that
   * repairs the gap happen at all.
   */
  it('remembers its rooms across a close, and refetches when it reopens', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    app.connection.join({ kind: 'order', orderId: 'order-1' });

    app.connection.close();
    app.connection.open();
    app.sockets.latest().serverConnect();

    expect(app.sockets.latest().emitted).toEqual([
      { event: ROOM_JOIN, payload: { kind: 'order', orderId: 'order-1' } },
    ]);
    expect(app.resumes()).toBe(1);
  });

  it('reports offline on close, rather than reconnecting', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();

    app.connection.close();

    expect(app.statuses.at(-1)).toBe('offline');
    expect(app.sockets.latest().disconnectCalls).toBe(1);
    expect(app.sockets.latest().listenerCount).toBe(0);
  });

  /** Signing in as another account must not inherit the first one's rooms. */
  it('forgets its rooms on reset', () => {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    app.connection.join({ kind: 'order', orderId: 'order-1' });

    app.connection.reset();
    app.connection.open();
    app.sockets.latest().serverConnect();

    expect(app.sockets.latest().emitted).toEqual([]);
    expect(app.resumes()).toBe(0);
  });
});

/**
 * The two endings socket.io does not retry by itself (issue #468): the server
 * closing a live socket — which the API does at every access token's `exp` —
 * and the server refusing the handshake. Before #468 the phone stayed on
 * `reconnecting` with no socket at all until the next foreground, and missed
 * every frame in between; on the device run that was a customer's price
 * decline.
 */
describe('when socket.io gives up on the socket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function live(): Harness {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    return app;
  }

  it('dials again after the server closes the socket, re-joins and refetches', async () => {
    const app = live();
    app.connection.join({ kind: 'order', orderId: 'order-1' });
    const socket = app.sockets.latest();

    socket.serverClose();
    expect(app.statuses.at(-1)).toBe('reconnecting');

    jest.advanceTimersByTime(recoveryDelayMs(0, () => 0.5));
    await settle();
    expect(app.endings).toEqual(['closed-by-server']);
    expect(socket.connectCalls).toBe(2);

    socket.serverConnect();
    expect(app.statuses.at(-1)).toBe('live');
    expect(socket.emitted.filter((frame) => frame.event === ROOM_JOIN)).toHaveLength(2);
    expect(app.resumes()).toBe(1);
  });

  it('presents the token recover renewed, not the one that expired', async () => {
    const app = live();
    app.answerRecovery(() => {
      app.setToken('token-2');
      return Promise.resolve('retry');
    });

    app.sockets.latest().serverClose();
    jest.advanceTimersByTime(recoveryDelayMs(0, () => 0.5));
    await settle();

    expect(app.sockets.latest().tokensPresented).toEqual(['token-1', 'token-2']);
  });

  /**
   * #474: the HTTP layer can rotate the stored token between the close and
   * the recovery, and only the socket's own token says whether it expired.
   */
  it('tells recover the token the closed socket presented, not the one stored since', async () => {
    const app = live();
    const presented: (string | null)[] = [];
    app.answerRecovery((_ending, token) => {
      presented.push(token);
      return Promise.resolve('retry');
    });

    app.sockets.latest().serverClose();
    app.setToken('token-2');
    jest.advanceTimersByTime(recoveryDelayMs(0, () => 0.5));
    await settle();

    expect(presented).toEqual(['token-1']);
  });

  it('stays closed, and says offline, when recover says stop', async () => {
    const app = live();
    app.answerRecovery(() => Promise.resolve('stop'));

    app.sockets.latest().serverClose();
    await jest.runOnlyPendingTimersAsync();
    await settle();

    expect(app.sockets.latest().connectCalls).toBe(1);
    expect(app.statuses.at(-1)).toBe('offline');
    // Nothing else is pending: a stopped socket is not retried later either.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a refused handshake, waiting twice as long each time', async () => {
    const app = harness();
    app.connection.open();
    const socket = app.sockets.latest();

    socket.serverRefuse();
    jest.advanceTimersByTime(1_000);
    await settle();
    expect(socket.connectCalls).toBe(2);
    expect(app.endings).toEqual(['refused']);

    socket.serverRefuse();
    jest.advanceTimersByTime(1_999);
    await settle();
    expect(socket.connectCalls).toBe(2);

    jest.advanceTimersByTime(1);
    await settle();
    expect(socket.connectCalls).toBe(3);
  });

  it('starts the wait again from the shortest after a connection succeeds', async () => {
    const app = live();
    const socket = app.sockets.latest();

    socket.serverClose();
    jest.advanceTimersByTime(1_000);
    await settle();
    socket.serverRefuse();
    jest.advanceTimersByTime(2_000);
    await settle();
    socket.serverConnect();

    socket.serverClose();
    jest.advanceTimersByTime(1_000);
    await settle();

    expect(socket.connectCalls).toBe(4);
  });

  it('leaves a dropped transport to socket.io, which is already retrying it', async () => {
    const app = live();

    app.sockets.latest().serverDisconnect();
    jest.advanceTimersByTime(60_000);
    await settle();

    expect(app.endings).toEqual([]);
    expect(app.sockets.latest().connectCalls).toBe(1);
  });

  it('does not dial once closed while it was waiting', async () => {
    const app = live();
    const socket = app.sockets.latest();

    socket.serverClose();
    app.connection.close();
    jest.advanceTimersByTime(60_000);
    await settle();

    expect(app.endings).toEqual([]);
    expect(socket.connectCalls).toBe(1);
  });

  /**
   * The app went to the background while a refresh was on the wire, and came
   * back with a new socket. The old one must not dial when the refresh lands:
   * it would be a second connection for the same account, with nothing
   * listening to it.
   */
  it('does not dial a socket replaced while recover was deciding', async () => {
    const app = live();
    let decide: (decision: Recovery) => void = () => undefined;
    app.answerRecovery(
      () =>
        new Promise<Recovery>((resolve) => {
          decide = resolve;
        }),
    );
    const first = app.sockets.latest();

    first.serverClose();
    jest.advanceTimersByTime(1_000);
    await settle();
    app.connection.close();
    app.connection.open();
    decide('retry');
    await settle();

    expect(first.connectCalls).toBe(1);
    expect(app.sockets.latest()).not.toBe(first);
    expect(app.sockets.latest().connectCalls).toBe(1);
  });

  it('retries when recover itself fails, rather than giving up for good', async () => {
    const app = live();
    app.answerRecovery(() => Promise.reject(new Error('keychain unavailable')));

    app.sockets.latest().serverClose();
    jest.advanceTimersByTime(1_000);
    await settle();

    expect(app.sockets.latest().connectCalls).toBe(2);
  });
});

describe('the manual reconnection backoff', () => {
  it('doubles from one second to a thirty-second ceiling', () => {
    const midpoint = (): number => 0.5;

    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => recoveryDelayMs(attempt, midpoint))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('spreads each wait by half either way, so phones do not return together', () => {
    expect(recoveryDelayMs(1, () => 0)).toBe(1_000);
    expect(recoveryDelayMs(1, () => 1)).toBe(3_000);
  });
});

/**
 * Call frames and requests over the same socket (issue #187). A call is not
 * cache state, so its frames go to whoever subscribed rather than into
 * `onEvent`, and its requests answer with the server's ack.
 */
describe('calls over the realtime connection', () => {
  const CALL_FRAME = {
    call: {
      id: 'call-1',
      orderId: 'order-1',
      status: 'ACCEPTED',
      endReason: null,
      role: 'caller',
      peer: { kind: 'master', displayName: 'Elvin' },
      startedAt: '2026-09-24T10:00:00.000Z',
      answeredAt: '2026-09-24T10:00:05.000Z',
      endedAt: null,
    },
    at: 2_000,
  };

  function live(): Harness {
    const app = harness();
    app.connection.open();
    app.sockets.latest().serverConnect();
    return app;
  }

  it('hands every call frame to its subscribers and none to the cache', () => {
    const app = live();
    const heard: unknown[] = [];
    app.connection.subscribeToCalls((frame) => heard.push(frame));

    app.sockets.latest().serverEmit('call:accepted', CALL_FRAME);
    app.sockets.latest().serverEmit('call:ended', CALL_FRAME);

    expect(heard).toEqual([
      { name: 'call:accepted', payload: CALL_FRAME },
      { name: 'call:ended', payload: CALL_FRAME },
    ]);
    expect(app.events).toEqual([]);
  });

  it('stops handing frames to a subscriber that left', () => {
    const app = live();
    const heard: unknown[] = [];
    const leave = app.connection.subscribeToCalls((frame) => heard.push(frame));

    leave();
    app.sockets.latest().serverEmit('call:ended', CALL_FRAME);

    expect(heard).toEqual([]);
  });

  it('keeps its subscribers across a backgrounding, onto the new socket', () => {
    const app = live();
    const heard: unknown[] = [];
    app.connection.subscribeToCalls((frame) => heard.push(frame));

    app.connection.close();
    app.connection.open();
    app.sockets.latest().serverConnect();
    app.sockets.latest().serverEmit('call:ended', CALL_FRAME);

    expect(heard).toHaveLength(1);
  });

  it('resolves a request with the server’s ack', async () => {
    const app = live();
    app.sockets.latest().answer('call:hangup', () => ({ ok: true, call: CALL_FRAME.call }));

    const ack = await app.connection.requestCall('call:hangup', { callId: 'call-1' });

    expect(ack).toEqual({ ok: true, call: CALL_FRAME.call });
    expect(app.sockets.latest().emitted).toEqual([
      { event: 'call:hangup', payload: { callId: 'call-1' } },
    ]);
  });

  /**
   * socket.io would buffer the frame and flush it on reconnect — an invite
   * that rings somebody long after the caller gave up. So it is not sent.
   */
  it('answers unavailable at once, and sends nothing, while the connection is down', async () => {
    const app = live();
    app.sockets.latest().serverDisconnect();

    const ack = await app.connection.requestCall('call:invite', { orderId: 'order-1' });

    expect(ack).toMatchObject({ ok: false, code: 'CALL_UNAVAILABLE' });
    expect(app.sockets.latest().emitted).toEqual([]);
  });

  it('answers unavailable with no socket at all', async () => {
    const app = harness();

    const ack = await app.connection.requestCall('call:invite', { orderId: 'order-1' });

    expect(ack).toMatchObject({ ok: false, code: 'CALL_UNAVAILABLE' });
  });

  describe('when the ack never comes', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('answers unavailable after the ack timeout rather than waiting forever', async () => {
      const app = live();
      app.sockets.latest().answer('call:accept', null);
      let ack: unknown;

      void app.connection.requestCall('call:accept', { callId: 'call-1' }).then((answer) => {
        ack = answer;
      });
      jest.advanceTimersByTime(CALL_ACK_TIMEOUT_MS - 1);
      await Promise.resolve();
      expect(ack).toBeUndefined();

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(ack).toMatchObject({ ok: false, code: 'CALL_UNAVAILABLE' });
    });
  });
});
