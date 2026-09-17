import { Module } from '@nestjs/common';

import { GeocodingInfraModule } from '../../infra/geo/geocoding.module';
import { GeocodingController } from './geocoding.controller';
import { GeocodingService } from './geocoding.service';

/**
 * The geocoding endpoints (EPIC 4, issue #36).
 *
 * Thin on purpose. `infra/geo` owns the provider boundary and the cache table;
 * this module owns the policy that joins them — when to read the cache, when
 * not to, and what to answer when the provider does not. That split is what
 * lets the provider be swapped without touching a request handler, and lets the
 * caching rule be read in one file rather than inferred from three.
 *
 * `GeocodingService` is exported because EPIC 6 geocodes an order's address at
 * creation and must go through this policy rather than calling the provider
 * directly — which would bypass the cache and the licence rule with it.
 */
@Module({
  imports: [GeocodingInfraModule],
  controllers: [GeocodingController],
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
