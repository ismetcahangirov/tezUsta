import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { MissingGoogleMapsApiKeyError } from './geocoding.module';
import { GoogleRoutesProvider } from './google-routes.provider';
import { ROUTING_PROVIDER } from './routing.types';
import type { RoutingProvider } from './routing.types';
import { StubRoutingProvider } from './stub-routing.provider';

/**
 * Chooses the {@link RoutingProvider} from `MAPS_PROVIDER`, the switch the
 * geocoding provider reads: one Maps vendor (ADR-0004), one key, one setting.
 * Exhaustive over the enum, so there is no `default` branch to go stale.
 */
function createRoutingProvider(config: AppConfig): RoutingProvider {
  switch (config.maps.provider) {
    case 'google': {
      const apiKey = config.maps.serverApiKey;
      if (apiKey === undefined) {
        throw new MissingGoogleMapsApiKeyError();
      }
      return new GoogleRoutesProvider({ apiKey, timeoutMs: config.maps.routesTimeoutMs });
    }
    case 'stub':
      return new StubRoutingProvider(config.runtime.nodeEnv);
  }
}

/**
 * Routing infrastructure: the provider behind its token, and nothing else.
 *
 * Its own module rather than a second export of `GeocodingInfraModule`,
 * because routing needs no database and no cache — the licence forbids
 * keeping what it returns (ADR-0055 § 7) — and importing the geocoding module
 * for it would drag the geocode cache into the arrival-promise job's graph.
 */
@Module({
  providers: [
    {
      provide: ROUTING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createRoutingProvider,
    },
  ],
  exports: [ROUTING_PROVIDER],
})
export class RoutingInfraModule {}
