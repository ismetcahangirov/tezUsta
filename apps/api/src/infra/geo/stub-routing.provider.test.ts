import { describe, expect, it } from 'vitest';

import { estimatedRoute } from './driving-estimate';
import { StubRoutingProvider, StubRoutingProviderInProductionError } from './stub-routing.provider';

const FROM = { latitude: 40.40926, longitude: 49.86709 } as const;
const TO = { latitude: 40.38, longitude: 49.84 } as const;

describe('StubRoutingProvider (issue #395)', () => {
  it('answers with the fallback estimate, so a stubbed promise matches a failed-route one', async () => {
    const provider = new StubRoutingProvider('test');

    await expect(provider.drivingRoute(FROM, TO)).resolves.toEqual(estimatedRoute(FROM, TO));
  });

  it('gives the same answer every time', async () => {
    const provider = new StubRoutingProvider('development');

    const first = await provider.drivingRoute(FROM, TO);
    const second = await provider.drivingRoute(FROM, TO);

    expect(second).toEqual(first);
  });

  it('refuses to construct under NODE_ENV=production', () => {
    expect(() => new StubRoutingProvider('production')).toThrow(
      StubRoutingProviderInProductionError,
    );
  });
});
