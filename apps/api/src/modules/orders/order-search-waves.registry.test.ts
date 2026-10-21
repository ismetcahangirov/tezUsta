import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it, vi } from 'vitest';

import type { OrderSearchWave } from './order-search-waves.registry';
import { OrderSearchWavesRegistry } from './order-search-waves.registry';

describe('OrderSearchWavesRegistry', () => {
  const wave: OrderSearchWave = { orderId: 'order-1', round: 2, radiusM: 3_000, offeredCount: 4 };

  it('swallows a failing announcement without the bound parameters of a failed query (#424)', async () => {
    const registry = new OrderSearchWavesRegistry();
    const warn = vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    // The radar's cells are read around the address: its point is a parameter.
    registry.register(
      vi
        .fn()
        .mockRejectedValue(
          new DrizzleQueryError(
            'select cells from order_offers where ST_MakePoint($1, $2)',
            [49.842717, 40.372613],
            new Error('connection terminated'),
          ),
        ),
    );

    await expect(registry.waved(wave)).resolves.toBeUndefined();

    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).toContain('order-1');
    expect(written).toContain('select cells from order_offers');
    expect(written).not.toContain('49.842717');
    expect(written).not.toContain('40.372613');
  });
});
