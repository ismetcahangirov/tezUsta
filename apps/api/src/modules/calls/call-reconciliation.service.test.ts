import { randomUUID } from 'node:crypto';

import type { CallStatus } from '@tezusta/types';
import { describe, expect, it } from 'vitest';

import { callRoomsByCallId, selectOrphanedRooms } from './call-reconciliation.service';

/**
 * Which listed rooms the reaper deletes (issue #186). Pure, so the cap can be
 * tested at 1 without a hundred live calls behind it.
 */
describe('selectOrphanedRooms', () => {
  function room(status: CallStatus | undefined): { id: string; name: string; status?: CallStatus } {
    const id = randomUUID();
    return status === undefined ? { id, name: `call-${id}` } : { id, name: `call-${id}`, status };
  }

  function select(rooms: readonly ReturnType<typeof room>[], cap: number): string[] {
    const ours = callRoomsByCallId(rooms.map((r) => r.name));
    const statuses = new Map<string, CallStatus>();
    for (const r of rooms) {
      if (r.status !== undefined) {
        statuses.set(r.id, r.status);
      }
    }
    return selectOrphanedRooms(ours, statuses, cap);
  }

  it('reaches an orphan listed behind more live rooms than the cap', () => {
    const live = [room('ACCEPTED'), room('ACCEPTED'), room('RINGING')];
    const orphan = room('ENDED');

    expect(select([...live, orphan], 1)).toEqual([orphan.name]);
  });

  it('takes rooms whose call is terminal or has no row, and caps only the deletions', () => {
    const ended = room('ENDED');
    const busy = room('BUSY');
    const missing = room(undefined);
    const live = room('ACCEPTED');

    expect(select([ended, live, busy, missing], 10)).toEqual([ended.name, busy.name, missing.name]);
    expect(select([ended, live, busy, missing], 2)).toEqual([ended.name, busy.name]);
  });

  it('ignores rooms this system did not name', () => {
    expect(callRoomsByCallId(['somebody-elses-room', 'call-not-a-uuid']).size).toBe(0);
  });
});
