import { Logger } from '@nestjs/common';

import type { GeocodedPoint, GeocodingProvider, StructuredAddress } from './geocoding.types';

/**
 * The one file in the repository that knows Google exists.
 * `geocoding.boundary.test.ts` scans `apps/api/src` and fails if the string
 * `googleapis` appears outside `infra/geo/`, so that claim is checked rather
 * than asserted.
 *
 * **No SDK.** `@googlemaps/google-maps-services-js` would be a dependency for
 * what is one `fetch` against a documented JSON endpoint, and its request and
 * response types would either cross this boundary — which ADR-0004 forbids — or
 * be re-wrapped here anyway, at which point it bought nothing. Node 24 has
 * global `fetch` (CLAUDE.md §10: "is it actually necessary, or is this a few
 * lines of our own code?").
 */
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Google answers 200 for everything and puts the real outcome in `status`.
 * Only two of these are worth another call; the rest are final, and retrying
 * them spends money to be told the same thing again.
 *
 * - `OK` — results follow.
 * - `ZERO_RESULTS` — the geocode succeeded and there is no such place. A final
 *   answer, mapped to `null`, **not** to an outage.
 * - `OVER_QUERY_LIMIT` — quota, transient.
 * - `UNKNOWN_ERROR` — documented verbatim as "the request may succeed if you
 *   try again".
 * - `REQUEST_DENIED`, `INVALID_REQUEST`, `OVER_DAILY_LIMIT` — our key, our
 *   query or our billing. Retrying cannot fix any of them.
 */
const RETRYABLE_STATUSES = new Set(['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR']);

/** Google's `address_components[].types` we map onto TezUsta's address fields. */
const COMPONENT_TYPES = {
  streetNumber: 'street_number',
  street: 'route',
  city: 'locality',
  postalCode: 'postal_code',
  /**
   * Baku's rayon sits at `administrative_area_level_1` for the city's own
   * districts in Google's index, with `sublocality` used in places. Both are
   * tried, nearest-first, because Google publishes no per-country guarantee
   * about which levels a nation exhibits — its own documentation says "not all
   * nations exhibit these levels". A missing district is `null`, never a guess.
   */
  district: ['sublocality', 'administrative_area_level_1'],
} as const;

/**
 * Thrown when the provider did not answer. The service turns it into
 * `unavailable` and the customer types the address by hand — never into a 5xx,
 * and never into "no such place".
 *
 * Carries no response body, no URL and no key: an error that quotes the request
 * it failed on is how an API key reaches a log.
 */
export class GeocodingProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`The geocoding provider did not answer: ${reason}.`);
    this.name = 'GeocodingProviderUnavailableError';
    Object.setPrototypeOf(this, GeocodingProviderUnavailableError.prototype);
  }
}

interface GoogleAddressComponent {
  readonly long_name?: unknown;
  readonly short_name?: unknown;
  readonly types?: unknown;
}

interface GoogleResult {
  readonly formatted_address?: unknown;
  readonly place_id?: unknown;
  readonly address_components?: unknown;
  readonly geometry?: { readonly location?: { readonly lat?: unknown; readonly lng?: unknown } };
}

interface GoogleResponse {
  readonly status?: unknown;
  readonly results?: unknown;
}

export interface GoogleGeocodingOptions {
  readonly apiKey: string;
  /** Response language. `az` is in Google's supported-language table. */
  readonly language: string;
  /** ISO 3166-1 country the results are restricted to, via `components`. */
  readonly countryCode: string;
  readonly timeoutMs: number;
}

export class GoogleGeocodingProvider implements GeocodingProvider {
  private readonly logger = new Logger(GoogleGeocodingProvider.name);

  constructor(private readonly options: GoogleGeocodingOptions) {}

  async forward(address: string): Promise<GeocodedPoint | null> {
    const params = new URLSearchParams({
      address,
      key: this.options.apiKey,
      language: this.options.language,
      // A hard filter, not the soft `region` bias: `components=country:AZ` is
      // documented as an enforced filter, and TezUsta does not dispatch outside
      // Azerbaijan. A Baku street name that also exists in Tbilisi must not
      // quietly resolve there.
      components: `country:${this.options.countryCode}`,
    });

    const result = await this.call(params);
    if (result === null) {
      return null;
    }

    const point = readLocation(result);
    return point === null ? null : { ...point, placeId: readString(result.place_id) };
  }

  async reverse(latitude: number, longitude: number): Promise<StructuredAddress | null> {
    const params = new URLSearchParams({
      latlng: `${String(latitude)},${String(longitude)}`,
      key: this.options.apiKey,
      language: this.options.language,
    });

    const result = await this.call(params);
    if (result === null) {
      return null;
    }

    const point = readLocation(result);
    const formattedAddress = readString(result.formatted_address);
    if (point === null || formattedAddress === null) {
      // A result with no address line is not one this product can use: the
      // whole purpose of the reverse lookup is to pre-fill text a customer
      // recognises.
      return null;
    }

    const components = readComponents(result.address_components);
    return {
      formattedAddress,
      streetNumber: pick(components, COMPONENT_TYPES.streetNumber),
      street: pick(components, COMPONENT_TYPES.street),
      district: pickFirst(components, COMPONENT_TYPES.district),
      city: pick(components, COMPONENT_TYPES.city),
      postalCode: pick(components, COMPONENT_TYPES.postalCode),
      latitude: point.latitude,
      longitude: point.longitude,
      placeId: readString(result.place_id),
    };
  }

  /**
   * One request, one decision: a usable result, `null` for "no such place", or
   * a throw for "did not answer".
   *
   * The URL is built here and never logged. It carries the API key and, on a
   * forward lookup, the customer's address — one of which is a credential and
   * the other PII (`docs/engineering/security.md`: never log "full addresses"
   * or keys). The logged line names the status and nothing else.
   */
  private async call(params: URLSearchParams): Promise<GoogleResult | null> {
    let response: Response;
    try {
      response = await fetch(`${GEOCODE_ENDPOINT}?${params.toString()}`, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      // The cause is deliberately not attached: a fetch error's message can
      // include the request URL, and that URL contains the key.
      throw new GeocodingProviderUnavailableError('the request failed or timed out');
    }

    if (!response.ok) {
      throw new GeocodingProviderUnavailableError(`HTTP ${String(response.status)}`);
    }

    let body: GoogleResponse;
    try {
      body = (await response.json()) as GoogleResponse;
    } catch {
      throw new GeocodingProviderUnavailableError('the response was not JSON');
    }

    const status = typeof body.status === 'string' ? body.status : 'UNKNOWN_ERROR';

    if (status === 'ZERO_RESULTS') {
      return null;
    }
    if (status !== 'OK') {
      if (!RETRYABLE_STATUSES.has(status)) {
        // REQUEST_DENIED, INVALID_REQUEST and OVER_DAILY_LIMIT are all our
        // fault — a bad key, a bad query, or billing. Worth a log line, because
        // nobody will notice a silent degradation to manual entry; still not
        // worth a 5xx, because the customer can proceed either way.
        this.logger.error(`Geocoding request rejected by the provider: ${status}.`);
      }
      throw new GeocodingProviderUnavailableError(status);
    }

    const results = Array.isArray(body.results) ? (body.results as GoogleResult[]) : [];
    return results[0] ?? null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readLocation(result: GoogleResult): { latitude: number; longitude: number } | null {
  const location = result.geometry?.location;
  const latitude = location?.lat;
  const longitude = location?.lng;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return null;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { latitude, longitude };
}

/**
 * Every response field is validated on the way in, even though it comes from
 * Google. An upstream that changes shape should degrade to a missing field, not
 * to a `TypeError` five layers down in a request handler.
 */
function readComponents(value: unknown): Map<string, string> {
  const byType = new Map<string, string>();
  if (!Array.isArray(value)) {
    return byType;
  }

  for (const entry of value as GoogleAddressComponent[]) {
    const name = readString(entry.long_name) ?? readString(entry.short_name);
    if (name === null || !Array.isArray(entry.types)) {
      continue;
    }
    for (const type of entry.types) {
      // First writer wins: Google orders components from most to least
      // specific, so an earlier `sublocality` is the nearer one.
      if (typeof type === 'string' && !byType.has(type)) {
        byType.set(type, name);
      }
    }
  }
  return byType;
}

function pick(components: Map<string, string>, type: string): string | null {
  return components.get(type) ?? null;
}

function pickFirst(components: Map<string, string>, types: readonly string[]): string | null {
  for (const type of types) {
    const value = components.get(type);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}
