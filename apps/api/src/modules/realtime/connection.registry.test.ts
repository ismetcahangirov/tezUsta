import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../infra/config/app-config.types';
import { ConnectionRegistry } from './connection.registry';
import type { AuthenticatedSocket } from './realtime.types';

const USER = '00000000-0000-4000-8000-00000000000a';
const OTHER_USER = '00000000-0000-4000-8000-00000000000b';

function configWithCap(maxConnectionsPerUser: number): AppConfig {
  return { realtime: { maxConnectionsPerUser } } as unknown as AppConfig;
}

/**
 * A socket that reproduces the one behaviour this registry's correctness turns
 * on: **`disconnect()` invokes the disconnect handler synchronously.**
 *
 * That is not an assumption. It was verified against the shipped socket.io —
 * calling `socket.disconnect(true)` emits `disconnect` and runs its listeners
 * before the call returns — which means the gateway's `handleDisconnect`, and
 * therefore `release`, runs re-entrantly inside `admit`'s eviction loop. A
 * fake that deferred the callback would make every test below pass while the
 * real thing broke.
 */
function fakeSocket(
  id: string,
  userId: string,
  onDisconnect: (socket: AuthenticatedSocket) => void,
): AuthenticatedSocket {
  const socket = {
    id,
    connected: true,
    data: { actor: { userId }, expiresAtMs: Date.now() + 900_000 },
    disconnect() {
      socket.connected = false;
      onDisconnect(socket as unknown as AuthenticatedSocket);
      return socket;
    },
  };

  return socket as unknown as AuthenticatedSocket;
}

describe('ConnectionRegistry (issue #166)', () => {
  /**
   * Wires the registry to itself the way the gateway does: a disconnect
   * reaches `release`. Without this the re-entrancy under test never happens.
   */
  function buildRegistry(cap: number): {
    registry: ConnectionRegistry;
    connect: (id: string, userId?: string) => AuthenticatedSocket;
  } {
    const registry = new ConnectionRegistry(configWithCap(cap));

    return {
      registry,
      connect(id, userId = USER) {
        const socket = fakeSocket(id, userId, (closed) => {
          registry.release(closed);
        });
        registry.admit(socket);
        return socket;
      },
    };
  }

  it('keeps every socket while the account is under the cap', () => {
    const { registry, connect } = buildRegistry(3);

    const first = connect('s1');
    const second = connect('s2');

    expect(registry.countFor(USER)).toBe(2);
    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
  });

  it('closes the oldest socket, not the newest, when the cap is passed', () => {
    const { registry, connect } = buildRegistry(2);

    const oldest = connect('s1');
    const middle = connect('s2');
    const newest = connect('s3');

    expect(oldest.connected).toBe(false);
    expect(middle.connected).toBe(true);
    expect(newest.connected).toBe(true);
    expect(registry.countFor(USER)).toBe(2);
  });

  it('stays consistent across many admissions past the cap', () => {
    // Ten admissions against a cap of two, each one triggering a synchronous
    // re-entrant `release` from inside `admit`'s eviction loop. What is being
    // pinned is that repeated eviction neither drifts the count upward nor
    // closes the wrong socket — the single-eviction e2e case cannot show
    // either.
    const { registry, connect } = buildRegistry(2);

    const sockets = Array.from({ length: 10 }, (_, index) => connect(`s${String(index)}`));

    expect(registry.countFor(USER)).toBe(2);
    expect(sockets.filter((socket) => socket.connected).map((socket) => socket.id)).toEqual([
      's8',
      's9',
    ]);
  });

  it('bounds each account separately', () => {
    const { registry, connect } = buildRegistry(1);

    const mine = connect('s1', USER);
    const theirs = connect('s2', OTHER_USER);

    expect(mine.connected).toBe(true);
    expect(theirs.connected).toBe(true);
    expect(registry.countFor(USER)).toBe(1);
    expect(registry.countFor(OTHER_USER)).toBe(1);
  });

  it('forgets an account once its last socket goes, rather than growing a map entry per user', () => {
    // A long-lived process admits every account that ever connects. An entry
    // left behind per past user is a slow leak with no upper bound.
    const { registry, connect } = buildRegistry(3);

    const socket = connect('s1');
    registry.release(socket);

    expect(registry.countFor(USER)).toBe(0);
  });

  it('ignores a release for a socket it never admitted', () => {
    const { registry, connect } = buildRegistry(3);
    connect('s1');

    // Never admitted, so its disconnect hook is never reached either — the
    // throw records that rather than leaving an empty function to read as an
    // intentional no-op.
    const stranger = fakeSocket('never-admitted', USER, () => {
      throw new Error('a socket that was never admitted must not be disconnected by the registry');
    });
    registry.release(stranger);

    expect(registry.countFor(USER)).toBe(1);
  });

  it('survives a second release of an already-evicted socket', () => {
    // `admit` removes an evicted socket from the list before closing it, and
    // the close then calls `release` for that same socket. The second removal
    // must find nothing and take nobody else with it.
    const { registry, connect } = buildRegistry(1);

    const evicted = connect('s1');
    const survivor = connect('s2');
    registry.release(evicted);

    expect(registry.countFor(USER)).toBe(1);
    expect(survivor.connected).toBe(true);
  });
});
