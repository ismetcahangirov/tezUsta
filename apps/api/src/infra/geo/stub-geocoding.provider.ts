import { Logger } from '@nestjs/common';

import { normaliseAddress } from './normalise-address';
import type { GeocodedPoint, GeocodingProvider, StructuredAddress } from './geocoding.types';

/**
 * Thrown from the provider factory, so a production deploy that forgot to
 * configure a real provider fails during `NestFactory.create` with a message
 * naming the variable — not on the first customer who tries to save an address.
 * The same fail-fast path `StubSmsSender` takes, for the same reason.
 */
export class StubGeocodingProviderInProductionError extends Error {
  constructor() {
    super(
      'MAPS_PROVIDER is "stub", which invents coordinates and must never run in ' +
        'production. Set MAPS_PROVIDER=google and GOOGLE_MAPS_SERVER_API_KEY (see ' +
        '.env.example). The key is billable and IP-restricted and must never carry ' +
        'the EXPO_PUBLIC_ prefix.',
    );
    this.name = 'StubGeocodingProviderInProductionError';
    Object.setPrototypeOf(this, StubGeocodingProviderInProductionError.prototype);
  }
}

/** Central Baku — every stub answer is a short walk from Fountains Square. */
const BAKU_CENTRE = { latitude: 40.40926, longitude: 49.86709 } as const;

/**
 * Roughly a kilometre, expressed in degrees at Baku's latitude. Only used to
 * spread stub results apart so a developer can see two saved addresses as two
 * pins rather than one.
 */
const SPREAD_DEGREES = 0.01;

/**
 * The development and test provider: deterministic, local, and free.
 *
 * **It exists so the rest of EPIC 4 does not wait on a billing account.**
 * Issue #36 asks for a stub explicitly, and `docs/engineering/testing-strategy.md`
 * puts the maps provider on the list of things to mock at the boundary. Every
 * test in this repository runs against this or against a fake supplied by the
 * test itself; none of them touches the network, which is what keeps the suite
 * runnable offline and keeps a green build from costing money.
 *
 * Answers are **derived from the input, not random**. The same address always
 * geocodes to the same point, so a cache test can tell a hit from a miss by
 * comparing values, and a developer's saved address does not move every time
 * the server restarts.
 */
export class StubGeocodingProvider implements GeocodingProvider {
  private readonly logger = new Logger(StubGeocodingProvider.name);

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new StubGeocodingProviderInProductionError();
    }
    this.logger.warn(
      'Geocoding is stubbed: coordinates are derived from the address text and are not real.',
    );
  }

  /**
   * The empty string is the one input that produces "no such place", so a
   * developer can exercise the `no-result` branch without a network. Anything
   * else gets a point derived from a hash of its normalised form.
   */
  forward(address: string): Promise<GeocodedPoint | null> {
    const key = normaliseAddress(address);
    if (key.length === 0) {
      return Promise.resolve(null);
    }

    const hash = fnv1a(key);
    return Promise.resolve({
      latitude: offset(BAKU_CENTRE.latitude, hash),
      longitude: offset(BAKU_CENTRE.longitude, hash >>> 16),
      placeId: `stub-${hash.toString(16)}`,
    });
  }

  /**
   * Returns the coordinate it was given, dressed in a plausible Baku address.
   * Echoing the point back matters: a reverse lookup that moved the pin would
   * make the "pre-fill a new address from the current position" flow visibly
   * wrong in development, and the bug would look like a mapping error rather
   * than a stub.
   */
  reverse(latitude: number, longitude: number): Promise<StructuredAddress | null> {
    const hash = fnv1a(`${String(latitude)},${String(longitude)}`);
    return Promise.resolve({
      formattedAddress: `Stub küçəsi ${String((hash % 90) + 1)}, Bakı`,
      streetNumber: String((hash % 90) + 1),
      street: 'Stub küçəsi',
      district: 'Səbail',
      city: 'Bakı',
      postalCode: null,
      latitude,
      longitude,
      placeId: `stub-${hash.toString(16)}`,
    });
  }
}

/**
 * FNV-1a, thirty-two bits. Not a security primitive and not used as one — it is
 * here because it is four lines, has no dependency, and spreads similar strings
 * apart, which is all a stub needs to put two addresses on two different pins.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function offset(base: number, hash: number): number {
  // Map the hash into [-1, 1) and scale, then round to five decimal places —
  // about a metre, which is the precision a real geocoder answers with anyway.
  const unit = ((hash % 20_000) - 10_000) / 10_000;
  return Math.round((base + unit * SPREAD_DEGREES) * 1e5) / 1e5;
}
