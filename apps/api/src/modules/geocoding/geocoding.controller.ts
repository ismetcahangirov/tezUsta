import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { ForwardGeocodeResult, ReverseGeocodeResult } from '@tezusta/types';
import type { FastifyRequest } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { GeocodingService } from './geocoding.service';
import { forwardGeocodeSchema, reverseGeocodeSchema } from './geocoding.schema';

class ForwardGeocodeDto extends createZodDto(forwardGeocodeSchema) {}
class ReverseGeocodeDto extends createZodDto(reverseGeocodeSchema) {}

/**
 * Identifies the geocode budget by the caller's user id.
 *
 * `RateLimitGuard` runs **before** `AuthenticationGuard` (see `app.module.ts`,
 * where the order is asserted by a test) — counting before rejecting is the
 * point of that order — so `request.actor` does not exist yet and this reads
 * the unverified claim instead.
 *
 * That is safe **here specifically, and nowhere else**. The value picks a
 * counter, not a permission: a forged `sub` moves the caller into a different
 * bucket and the request is then rejected by the guard that actually verifies
 * the signature, so it never reaches the provider and never spends money. The
 * per-IP half of the policy still applies throughout, which is what stops the
 * forgery from being a way to buy unlimited budget. Nothing about authorization
 * reads this.
 */
function rateLimitByUser(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return undefined;
  }
  const payload = header.slice('Bearer '.length).split('.')[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const sub = (claims as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    // An unparseable token carries no identifier. Returning undefined leaves
    // the per-IP limit in force, so a malformed request is never a free one.
    return undefined;
  }
}

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
