import { Logger } from '@nestjs/common';

import { straightLineMeters } from './driving-estimate';
import type { RouteEstimate, RoutePoint, RoutingProvider } from './routing.types';

/**
 * The Routes API's `computeRoutes`, called with one `fetch` and no SDK, for
 * the reason `google-geocoding.provider.ts` gives: a dependency for one
 * documented JSON endpoint would either leak its types across the boundary or
 * be re-wrapped here anyway.
 *
 * Request and response shapes are from Google's reference, read on
 * 20 October 2026:
 * https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes
 * The choices below are ADR-0055 § 7's, and each one has a cost or a licence
 * behind it.
 */
const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * **Mandatory, and the narrowest that answers the question.** The method
 * returns an error without a field mask and has no default field list. Asking
 * for more costs latency and, for some fields (tolls, traffic on polylines),
 * moves the request into the Enterprise SKU.
 */
const FIELD_MASK = 'routes.duration,routes.distanceMeters';

/**
 * Live traffic, which is what makes a Baku rush-hour promise honest, and what
 * moves the request from the Essentials SKU to Pro. `TRAFFIC_AWARE_OPTIMAL`
 * costs the same SKU at Google's "highest latency" (ADR-0055 § 7).
 *
 * Deliberately **not** sent: `departureTime` (it defaults to the time of the
 * request, which is the departure we mean), and `languageCode` / `units`,
 * which Google documents as affecting display fields only. This mask asks for
 * none, so either would be a value that could only fail the request.
 */
const ROUTING_PREFERENCE = 'TRAFFIC_AWARE';

/**
 * How far a road route may come out *shorter* than the straight line before
 * it is refused as no route. Google snaps both ends onto the road network, so
 * two points in a courtyard can legitimately route a little under their
 * straight-line distance; a route hundreds of metres shorter than the crow
 * flies is not a road on this planet (ADR-0055 § 7).
 */
const SNAP_ALLOWANCE_M = 200;

/**
 * A protobuf `Duration` in its JSON form: whole seconds, up to nine fractional
 * digits, and an `s`. Google's example is `"165s"`.
 */
const DURATION_PATTERN = /^(\d+)(?:\.(\d{1,9}))?s$/;

/**
 * The only shape of text from an error body this provider will repeat in a
 * log: an enum-like token such as `PERMISSION_DENIED` or `API_KEY_INVALID`.
 * The body's `message` is free text and is never logged.
 */
const STATUS_TOKEN = /^[A-Z][A-Z_]{1,63}$/;

/**
 * Thrown when the provider did not answer. The arrival-promise job catches it
 * and uses the estimate (#396); it never reaches a client.
 *
 * Carries no URL, no key, no coordinate and no response body: an error that
 * quotes its request is how a key or a master's position reaches a log.
 */
export class RoutingProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`The routing provider did not answer: ${reason}.`);
    this.name = 'RoutingProviderUnavailableError';
    Object.setPrototypeOf(this, RoutingProviderUnavailableError.prototype);
  }
}

interface GoogleRoute {
  readonly duration?: unknown;
  readonly distanceMeters?: unknown;
}

interface GoogleRoutesResponse {
  readonly routes?: unknown;
}

interface GoogleErrorBody {
  readonly error?: {
    readonly status?: unknown;
    readonly details?: unknown;
  };
}

export interface GoogleRoutesOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export class GoogleRoutesProvider implements RoutingProvider {
  private readonly logger = new Logger(GoogleRoutesProvider.name);

  constructor(private readonly options: GoogleRoutesOptions) {}

  async drivingRoute(from: RoutePoint, to: RoutePoint): Promise<RouteEstimate | null> {
    const body = await this.call({
      origin: waypoint(from),
      destination: waypoint(to),
      travelMode: 'DRIVE',
      routingPreference: ROUTING_PREFERENCE,
    });

    // Proto3 JSON omits an empty repeated field, so "no route" can arrive as
    // `{}` as well as `{ "routes": [] }`. Google: "If the array is empty, then
    // it means no route could be found."
    const routes = body.routes === undefined ? [] : body.routes;
    if (!Array.isArray(routes)) {
      throw new RoutingProviderUnavailableError('the response had no readable routes');
    }

    const first = routes[0] as GoogleRoute | undefined;
    if (first === undefined) {
      return null;
    }

    const durationSeconds = readDurationSeconds(first.duration);
    const distanceMeters = readDistanceMeters(first.distanceMeters);
    if (durationSeconds === null || distanceMeters === null) {
      // A route we cannot read is not "no route": Google answered something
      // this parser does not understand, and the estimate is the honest
      // fallback for that, not a promise built on a guess.
      throw new RoutingProviderUnavailableError('the route could not be read');
    }

    if (distanceMeters + SNAP_ALLOWANCE_M < straightLineMeters(from, to)) {
      this.logger.warn('A route shorter than the straight line was refused as no route.');
      return null;
    }

    return { durationSeconds, distanceMeters };
  }

  /**
   * One POST, one decision. The key travels in a header, never in the URL, so
   * neither an access log nor a fetch error's message can carry it.
   */
  private async call(payload: unknown): Promise<GoogleRoutesResponse> {
    let response: Response;
    try {
      response = await fetch(ROUTES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.options.apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      // The cause is not attached: it can quote the request.
      throw new RoutingProviderUnavailableError('the request failed or timed out');
    }

    if (!response.ok) {
      await this.reportRejection(response);
      throw new RoutingProviderUnavailableError(`HTTP ${String(response.status)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RoutingProviderUnavailableError('the response was not JSON');
    }

    if (typeof body !== 'object' || body === null) {
      throw new RoutingProviderUnavailableError('the response was not an object');
    }
    return body;
  }

  /**
   * A 4xx is ours — the key, its restrictions, or the request — and nobody
   * notices an arrival promise that quietly became an estimate, so it is
   * logged at `error`. The most likely first-deploy failure is a server key
   * whose API restrictions do not list the Routes API, which Google answers
   * with `PERMISSION_DENIED`; that line says so in words.
   *
   * A 5xx or a 429 is Google's or transient, and is the fallback's job, so it
   * is a `warn`. Only enum-like tokens from the body are repeated.
   */
  private async reportRejection(response: Response): Promise<void> {
    const { status, reason } = await readErrorTokens(response);
    const detail = [status, reason].filter((token) => token !== null).join(' ');
    const line = `Routes request rejected: HTTP ${String(response.status)}${
      detail.length > 0 ? ` ${detail}` : ''
    }.`;

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      this.logger.error(
        status === 'PERMISSION_DENIED'
          ? `${line} Check that the Routes API is enabled for GOOGLE_MAPS_SERVER_API_KEY's project and listed in the key's API restrictions.`
          : line,
      );
      return;
    }
    this.logger.warn(line);
  }
}

function waypoint(point: RoutePoint): unknown {
  return { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } };
}

/** Fractional seconds round up: the master gets the benefit of the doubt. */
function readDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const whole = Number(match[1]);
  const fraction = match[2];
  if (!Number.isSafeInteger(whole)) {
    return null;
  }
  return fraction !== undefined && /[1-9]/.test(fraction) ? whole + 1 : whole;
}

/**
 * An `int32` in Google's JSON, and absent when it is zero — proto3 omits
 * default values, so a route between two points on the same spot has no
 * `distanceMeters` at all. Absent therefore reads as 0; anything present must
 * be a non-negative integer.
 */
function readDistanceMeters(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readErrorTokens(
  response: Response,
): Promise<{ status: string | null; reason: string | null }> {
  let body: GoogleErrorBody;
  try {
    body = (await response.json()) as GoogleErrorBody;
  } catch {
    return { status: null, reason: null };
  }

  const status = readToken(body.error?.status);
  const details = body.error?.details;
  const reason = Array.isArray(details)
    ? (details
        .map((detail: unknown) =>
          typeof detail === 'object' && detail !== null
            ? readToken((detail as { reason?: unknown }).reason)
            : null,
        )
        .find((token) => token !== null) ?? null)
    : null;

  return { status, reason };
}

function readToken(value: unknown): string | null {
  return typeof value === 'string' && STATUS_TOKEN.test(value) ? value : null;
}
