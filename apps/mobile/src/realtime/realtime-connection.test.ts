import type { OrderTransitionRealtimeEvent } from '@tezusta/types';

import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';

import type { ConnectionStatus } from './connection-slice';
import { CALL_ACK_TIMEOUT_MS, createRealtimeConnection } from './realtime-connection';
import type { RealtimeConnection } from './realtime-connection';
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
  resumes(): number;
  setToken(token: string | null): void;
}

function harness(): Harness {
  const sockets = createFakeSocketFactory();
  const statuses: ConnectionStatus[] = [];
  const events: RealtimeEvent[] = [];
  let resumed = 0;
  let token: string | null = 'token-1';

  const connection = createRealtimeConnection({
    getToken: () => token,
    onStatus: (status) => statuses.push(status),
    onEvent: (event) => events.push(event),
    onResumed: () => {
      resumed += 1;
    },
    createSocket: sockets.factory,
  });

  return {
    connection,
    sockets,
    statuses,
    events,
    resumes: () => resumed,
    setToken: (next) => {
      token = next;
    },
  };
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
