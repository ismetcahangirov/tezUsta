import type { OrderTransitionRealtimeEvent } from '@tezusta/types';

import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';

import type { ConnectionStatus } from './connection-slice';
import { createRealtimeConnection } from './realtime-connection';
import type { RealtimeConnection } from './realtime-connection';
import type { RealtimeEvent } from './realtime-events';
import { ORDER_TRANSITION_EVENT, ROOM_JOIN, ROOM_LEAVE } from './realtime-events';

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
