import { useEffect } from 'react';

import { useRealtimeConnection } from './RealtimeProvider';

/**
 * Listens to one order for as long as this screen is on it (issue #170).
 *
 * **The screen asks; the server decides.** A join is a request the server
 * re-authorizes against the row as it stands, and refuses indistinguishably
 * for "not yours", "not there" and "no longer live" (#167). So nothing here
 * checks whether the order is one this user may watch — the client has no
 * business holding that rule, and duplicating it would put a second, staler
 * copy of it on a phone.
 *
 * **Leaving on unmount is not politeness.** A customer who backs out of one
 * order and opens another would otherwise still be in the first room, and the
 * inbound budget (`REALTIME_INBOUND_*`) is spent per connection, so rooms that
 * accumulate are frames that arrive for screens nobody is looking at.
 *
 * `orderId` may be `undefined` while a route parameter is still resolving; the
 * hook simply does nothing, because a hook that could not be called
 * unconditionally would be a hook the screen has to branch around.
 */
export function useOrderRoom(orderId: string | undefined): void {
  const connection = useRealtimeConnection();

  useEffect(() => {
    if (connection === null || orderId === undefined) {
      return;
    }

    connection.join({ kind: 'order', orderId });

    return () => {
      connection.leave({ kind: 'order', orderId });
    };
  }, [connection, orderId]);
}
