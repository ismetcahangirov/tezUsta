import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ForwardGeocodeResult, ReverseGeocodeResult } from '@tezusta/types';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { GeocodeCacheRepository } from '../../infra/geo/geocode-cache.repository';
import { GEOCODING_PROVIDER } from '../../infra/geo/geocoding.types';
import type { GeocodingProvider } from '../../infra/geo/geocoding.types';
import { normaliseAddress } from '../../infra/geo/normalise-address';

/**
 * Read-through caching and graceful degradation — the policy that sits between
 * a request and the provider.
 *
 * Two rules, and they are the whole module:
 *
 * 1. **A forward lookup goes through the cache; a reverse lookup never does.**
 *    Not a performance judgement — a licence one. Google's Maps Service
 *    Specific Terms §6.3.1 permit caching lat/lng for up to thirty days, while
 *    §6.3.2 permits keeping a formatted address only where the cache is
 *    "logically isolated to the specific End User" and "must not be used across
 *    multiple End Users". A shared cache of reverse results is exactly what
 *    that forbids, so reverse pays the provider every time and its answer is
 *    persisted only where it belongs: in the customer's own saved address.
 * 2. **A provider that does not answer degrades; it never 500s.** The customer
 *    is in the middle of saving an address, and the fallback — typing it and
 *    dropping a pin — is a perfectly good outcome that EPIC 4 requires the flow
 *    to reach. Turning an upstream outage into a server error would dead-end
 *    that flow and page somebody for a problem they cannot fix.
 *
 * Nothing here logs an address or a coordinate. Both are PII
 * (`docs/engineering/security.md`: never log "precise coordinates" or "full
 * addresses"), and a cache is exactly the kind of component whose debug logging
 * quietly becomes a location history.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    @Inject(GEOCODING_PROVIDER) private readonly provider: GeocodingProvider,
    private readonly cache: GeocodeCacheRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async forward(address: string): Promise<ForwardGeocodeResult> {
    const key = normaliseAddress(address);
    if (key.length === 0) {
      // Everything the customer typed was punctuation or whitespace. Calling
      // the provider with it would pay for a guaranteed ZERO_RESULTS.
      return { status: 'no-result' };
    }

    const cached = await this.cache.get(key);
    if (cached !== undefined) {
      return { status: 'ok', ...cached };
    }

    let point;
    try {
      point = await this.provider.forward(address);
    } catch (error) {
      return this.degrade(error);
    }

    if (point === null) {
      // Deliberately not cached. A negative result is cheap to reproduce, and
      // caching it would mean an address Google indexes next week keeps
      // answering "no such place" until the entry expires.
      return { status: 'no-result' };
    }

    // The write is awaited rather than fired and forgotten: an unawaited
    // promise that rejects is an unhandled rejection, and a cache that silently
    // fails to write is a Maps invoice nobody can explain. A failure here is
    // still not the customer's problem — they have their answer — so it is
    // caught and logged rather than thrown.
    try {
      await this.cache.put(key, point, this.config.maps.geocodeCacheTtlDays);
    } catch {
      this.logger.warn('Geocode cache write failed; this lookup will be paid for again.');
    }

    return { status: 'ok', ...point };
  }

  async reverse(latitude: number, longitude: number): Promise<ReverseGeocodeResult> {
    try {
      const address = await this.provider.reverse(latitude, longitude);
      return address === null ? { status: 'no-result' } : { status: 'ok', address };
    } catch (error) {
      return this.degrade(error);
    }
  }

  /**
   * The one place an upstream failure becomes an answer.
   *
   * Logs the error's name, never its message: a provider error can carry the
   * request URL, and that URL carries the API key and the address that was
   * being looked up. The name is enough to tell a timeout from a rejection,
   * and the provider already logs the cases that indicate our own
   * misconfiguration.
   */
  private degrade(error: unknown): { status: 'unavailable' } {
    const name = error instanceof Error ? error.name : 'unknown error';
    this.logger.warn(`Geocoding degraded to manual entry: ${name}.`);
    return { status: 'unavailable' };
  }
}
