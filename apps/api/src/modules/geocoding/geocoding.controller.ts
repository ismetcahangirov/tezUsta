import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { ForwardGeocodeResult, ReverseGeocodeResult } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import { GeocodingService } from './geocoding.service';
import { forwardGeocodeSchema, reverseGeocodeSchema } from './geocoding.schema';

class ForwardGeocodeDto extends createZodDto(forwardGeocodeSchema) {}
class ReverseGeocodeDto extends createZodDto(reverseGeocodeSchema) {}

/**
 * Forward and reverse geocoding, for the address screens.
 *
 * **POST, not GET, and that is a privacy decision rather than a REST one.** A
 * GET puts the address or the coordinate in the URL, and a URL is the single
 * most-logged string in any stack — access logs, proxies, browser history,
 * crash reporters, the referer header. `docs/engineering/security.md` forbids
 * logging full addresses and precise coordinates, and the cheapest way to keep
 * that promise is for them never to be in a line anything logs by default. It
 * also keeps intermediaries from caching a response that is about one person.
 *
 * **Authenticated and rate-limited**, because every call that reaches the
 * provider spends money ([ADR-0004](docs/decisions/ADR-0004-location-and-maps.md)).
 * The cache is the first defence and the limit is the second: a loop over
 * *distinct* addresses misses the cache by construction, and only a budget
 * stops it.
 */
@Controller('geocode')
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  /**
   * 200 for every outcome, including "the provider is unavailable" — see
   * `@tezusta/types`' `ForwardGeocodeResult`. The client switches on `status`,
   * so falling back to manual entry is the same code path as "no such address"
   * rather than an error handler somebody has to remember to write.
   *
   * `@HttpCode(200)` because this POST creates nothing; 201 would be a lie
   * about a lookup.
   */
  @Post('forward')
  @HttpCode(200)
  @RateLimit({ policy: 'geocode', identifier: rateLimitByUser })
  async forward(@Body() body: ForwardGeocodeDto): Promise<ForwardGeocodeResult> {
    return this.geocoding.forward(body.address);
  }

  @Post('reverse')
  @HttpCode(200)
  @RateLimit({ policy: 'geocode', identifier: rateLimitByUser })
  async reverse(@Body() body: ReverseGeocodeDto): Promise<ReverseGeocodeResult> {
    return this.geocoding.reverse(body.latitude, body.longitude);
  }
}
