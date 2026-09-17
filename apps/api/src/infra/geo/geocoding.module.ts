import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DatabaseModule } from '../database/database.module';
import { GeocodeCacheRepository } from './geocode-cache.repository';
import { GEOCODING_PROVIDER } from './geocoding.types';
import type { GeocodingProvider } from './geocoding.types';
import { GoogleGeocodingProvider } from './google-geocoding.provider';
import { StubGeocodingProvider } from './stub-geocoding.provider';

/**
 * Thrown from the factory so a deploy that selected Google without a key fails
 * during `NestFactory.create`, naming the variable — rather than degrading
 * every customer to manual address entry with an error in a log nobody reads.
 */
export class MissingGoogleMapsApiKeyError extends Error {
  constructor() {
    super(
      'MAPS_PROVIDER is "google" but GOOGLE_MAPS_SERVER_API_KEY is not set. The key is ' +
        'billable and IP-restricted; it belongs to the API process alone and must never ' +
        'carry the EXPO_PUBLIC_ prefix, which embeds it in the shipped app bundle ' +
        '(CLAUDE.md §4). See .env.example.',
    );
    this.name = 'MissingGoogleMapsApiKeyError';
    Object.setPrototypeOf(this, MissingGoogleMapsApiKeyError.prototype);
  }
}

/**
 * Chooses the {@link GeocodingProvider} from validated configuration — the same
 * shape `SmsModule` takes, and for the same reason: swapping providers is one
 * new file plus one enum member, and nothing above this line changes.
 *
 * The `switch` is exhaustive over `MAPS_PROVIDER`'s enum, so it has no
 * `default` branch to go stale.
 */
function createGeocodingProvider(config: AppConfig): GeocodingProvider {
  switch (config.maps.provider) {
    case 'google': {
      const apiKey = config.maps.serverApiKey;
      if (apiKey === undefined) {
        throw new MissingGoogleMapsApiKeyError();
      }
      return new GoogleGeocodingProvider({
        apiKey,
        language: config.maps.geocodeLanguage,
        countryCode: config.maps.geocodeCountry,
        timeoutMs: config.maps.geocodeTimeoutMs,
      });
    }
    case 'stub':
      // Refuses to construct under NODE_ENV=production, so the default that
      // makes a fresh clone work cannot quietly reach a deploy.
      return new StubGeocodingProvider(config.runtime.nodeEnv);
  }
}

/**
 * Geocoding infrastructure: the provider behind its interface, and the Postgres
 * cache in front of it.
 *
 * Exports the provider token and the cache rather than a service, because the
 * read-through policy — when to call, what to do when the call fails — is a
 * decision about the request, and lives in `modules/geocoding`.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: GEOCODING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createGeocodingProvider,
    },
    GeocodeCacheRepository,
  ],
  exports: [GEOCODING_PROVIDER, GeocodeCacheRepository],
})
export class GeocodingInfraModule {}
