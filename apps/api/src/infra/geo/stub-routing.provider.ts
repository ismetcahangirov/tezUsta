import { Logger } from '@nestjs/common';

import { estimatedRoute } from './driving-estimate';
import type { RouteEstimate, RoutePoint, RoutingProvider } from './routing.types';

/**
 * Thrown from the provider factory, so a production deploy left on the stub
 * fails at boot naming the variable, as `StubGeocodingProviderInProductionError`
 * does — rather than promising every master an arrival time computed from a
 * straight line.
 */
export class StubRoutingProviderInProductionError extends Error {
  constructor() {
    super(
      'MAPS_PROVIDER is "stub", which estimates routes from straight lines and must ' +
        'never run in production. Set MAPS_PROVIDER=google and GOOGLE_MAPS_SERVER_API_KEY, ' +
        'with the Routes API enabled for that key (see .env.example).',
    );
    this.name = 'StubRoutingProviderInProductionError';
    Object.setPrototypeOf(this, StubRoutingProviderInProductionError.prototype);
  }
}

/**
 * The development and test provider: deterministic, local and free.
 *
 * **Its answer is the fallback estimate itself** (`driving-estimate.ts`,
 * ADR-0055 § 10), not a second formula. A developer therefore sees the same
 * promise with or without a key, and a test can compute the exact expected
 * value from the same function rather than hard-coding a number that drifts
 * the day the constants are calibrated.
 */
export class StubRoutingProvider implements RoutingProvider {
  private readonly logger = new Logger(StubRoutingProvider.name);

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new StubRoutingProviderInProductionError();
    }
    this.logger.warn('Routing is stubbed: travel times are straight-line estimates, not routes.');
  }

  drivingRoute(from: RoutePoint, to: RoutePoint): Promise<RouteEstimate | null> {
    return Promise.resolve(estimatedRoute(from, to));
  }
}
