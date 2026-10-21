import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it, vi } from 'vitest';

import { MasterLocationRegistry } from './master-location.registry';
import type { MasterPositionReported } from './master-location.registry';

/**
 * The seam a recorded position leaves `modules/masters` through (issue #169).
 *
 * **The behaviour under test is that a fan-out cannot cost a report.** The
 * position is already in `master_locations` and presence is already refreshed
 * by the time this runs; turning a Redis hiccup into a 500 would make a
 * master's app retry a write it has already done, and still show the customer
 * nothing.
 *
 * The second property is that no coordinate reaches the failure log
 * (CLAUDE.md §11) — asserted here rather than only end-to-end, because this is
 * the one line in the fan-out path that formats an error message.
 */
describe('MasterLocationRegistry', () => {
  const event: MasterPositionReported = {
    masterId: 'master-1',
    latitude: 40.123456,
    longitude: 49.987654,
    recordedAt: new Date('2026-09-23T08:00:00.000Z'),
  };

  it('hands the recorded position to the listener', async () => {
    const registry = new MasterLocationRegistry();
    const listener = vi.fn().mockResolvedValue(undefined);

    registry.register('map', listener);
    await registry.reported(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('hands it to every listener, and one failing does not stop another (#414)', async () => {
    const registry = new MasterLocationRegistry();
    vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    const nearby = vi.fn().mockResolvedValue(undefined);
    registry.register('map', vi.fn().mockRejectedValue(new Error('socket is down')));
    registry.register('nearby', nearby);

    await registry.reported(event);

    expect(nearby).toHaveBeenCalledWith(event);
  });

  it('says nothing at all with no listener registered', async () => {
    await expect(new MasterLocationRegistry().reported(event)).resolves.toBeUndefined();
  });

  it('swallows a failing fan-out, naming the master and never the point', async () => {
    const registry = new MasterLocationRegistry();
    const warn = vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    registry.register('map', vi.fn().mockRejectedValue(new Error('redis is unreachable')));

    await expect(registry.reported(event)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).toContain('master-1');
    expect(written).not.toContain('40.123456');
    expect(written).not.toContain('49.987654');
  });

  it('never logs the bound parameters of a failed query, which carry the point (#424)', async () => {
    const registry = new MasterLocationRegistry();
    const warn = vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    registry.register(
      'nearby',
      vi
        .fn()
        .mockRejectedValue(
          new DrizzleQueryError(
            'select 1 from orders o where ST_MakePoint($1, $2)',
            [49.987654, 40.123456],
            new Error('connection terminated'),
          ),
        ),
    );

    await registry.reported(event);

    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).toContain('master-1');
    expect(written).toContain('select 1 from orders');
    expect(written).not.toContain('40.123456');
    expect(written).not.toContain('49.987654');
  });

  it('refuses a second listener under the same name', () => {
    const registry = new MasterLocationRegistry();
    registry.register('map', vi.fn());

    expect(() => {
      registry.register('map', vi.fn());
    }).toThrow(/already registered/);
  });
});
