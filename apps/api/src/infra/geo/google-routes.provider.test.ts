import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';

import { expectLoggerIsListening, spyOnEveryLogSink } from '../../../test/support/log-sink';
import { straightLineMeters } from './driving-estimate';
import { GoogleRoutesProvider, RoutingProviderUnavailableError } from './google-routes.provider';

const API_KEY = 'AIzaSy-test-server-key-0123456789';

/** A master in Nəsimi and a job near Fountains Square, about 3 km apart. */
const FROM = { latitude: 40.39472, longitude: 49.84931 } as const;
const TO = { latitude: 40.37106, longitude: 49.83706 } as const;

/** Every coordinate digit string that must never reach an error or a log. */
const COORDINATE_STRINGS = [FROM, TO].flatMap((point) => [
  String(point.latitude),
  String(point.longitude),
]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GoogleRoutesProvider (issue #395, ADR-0055 § 7)', () => {
  let fetchMock: Mock<typeof fetch>;
  let sink: string[];
  let sinkSpies: MockInstance[];

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    sink = [];
    sinkSpies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const spy of sinkSpies) {
      spy.mockRestore();
    }
  });

  function provider(): GoogleRoutesProvider {
    return new GoogleRoutesProvider({ apiKey: API_KEY, timeoutMs: 3_000 });
  }

  /** The thrown error, so its message can be checked for leaks. */
  async function failure(): Promise<RoutingProviderUnavailableError> {
    const error: unknown = await provider()
      .drivingRoute(FROM, TO)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(RoutingProviderUnavailableError);
    return error as RoutingProviderUnavailableError;
  }

  function expectNoLeak(text: string): void {
    expect(text).not.toContain(API_KEY);
    for (const coordinate of COORDINATE_STRINGS) {
      expect(text).not.toContain(coordinate);
    }
  }

  describe('the request', () => {
    it('POSTs a traffic-aware drive with the field mask, and the key only in a header', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { routes: [{ duration: '742s', distanceMeters: 4_180 }] }),
      );

      await provider().drivingRoute(FROM, TO);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
      expect(url as string).not.toContain(API_KEY);
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      const headers = new Headers(init?.headers);
      expect(headers.get('X-Goog-Api-Key')).toBe(API_KEY);
      expect(headers.get('X-Goog-FieldMask')).toBe('routes.duration,routes.distanceMeters');
      expect(headers.get('Content-Type')).toBe('application/json');

      expect(JSON.parse(init?.body as string)).toEqual({
        origin: { location: { latLng: { latitude: FROM.latitude, longitude: FROM.longitude } } },
        destination: { location: { latLng: { latitude: TO.latitude, longitude: TO.longitude } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
      });
    });
  });

  describe('a route', () => {
    it('returns integer seconds and metres from Google’s documented success body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { routes: [{ distanceMeters: 4_180, duration: '742s' }] }),
      );

      await expect(provider().drivingRoute(FROM, TO)).resolves.toEqual({
        durationSeconds: 742,
        distanceMeters: 4_180,
      });
    });

    it('rounds a fractional duration up', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { routes: [{ duration: '742.000000001s', distanceMeters: 4_180 }] }),
      );

      await expect(provider().drivingRoute(FROM, TO)).resolves.toMatchObject({
        durationSeconds: 743,
      });
    });

    it('reads an absent distance as zero, because proto3 JSON omits default values', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { routes: [{ duration: '0s' }] }));

      await expect(provider().drivingRoute(TO, TO)).resolves.toEqual({
        durationSeconds: 0,
        distanceMeters: 0,
      });
    });

    it.each([{ routes: [] }, {}])('returns null for no route: %j', async (body) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));

      await expect(provider().drivingRoute(FROM, TO)).resolves.toBeNull();
    });

    it('refuses as no route a road far shorter than the straight line', async () => {
      const straightLine = straightLineMeters(FROM, TO);
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          routes: [{ duration: '60s', distanceMeters: Math.round(straightLine - 500) }],
        }),
      );

      await expect(provider().drivingRoute(FROM, TO)).resolves.toBeNull();
    });

    it('accepts a road a little shorter than the straight line, as snapping makes it', async () => {
      const distance = Math.round(straightLineMeters(FROM, TO) - 50);
      fetchMock.mockResolvedValue(
        jsonResponse(200, { routes: [{ duration: '600s', distanceMeters: distance }] }),
      );

      await expect(provider().drivingRoute(FROM, TO)).resolves.toEqual({
        durationSeconds: 600,
        distanceMeters: distance,
      });
    });
  });

  describe('no answer', () => {
    it.each([
      ['a missing duration', { routes: [{ distanceMeters: 4_180 }] }],
      ['a garbled duration', { routes: [{ duration: '12 minutes', distanceMeters: 4_180 }] }],
      ['a numeric duration', { routes: [{ duration: 742, distanceMeters: 4_180 }] }],
      ['a negative distance', { routes: [{ duration: '742s', distanceMeters: -1 }] }],
      ['routes that are not a list', { routes: 'none' }],
    ])('throws for %s', async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));

      expectNoLeak((await failure()).message);
    });

    it('throws for a body that is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>busy</html>', { status: 200 }));

      expect((await failure()).message).toMatch(/not JSON/);
    });

    it('throws for a timeout (an aborted signal)', async () => {
      fetchMock.mockRejectedValue(
        new DOMException(`The operation was aborted: ${String(FROM.latitude)}`, 'TimeoutError'),
      );

      const error = await failure();
      expect(error.message).toMatch(/failed or timed out/);
      expect(error.cause).toBeUndefined();
      expectNoLeak(error.message);
    });

    it('throws for a 5xx and logs it as a warning, not an error', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } }),
      );

      expect((await failure()).message).toMatch(/HTTP 503/);
      expect(sink.some((line) => line.includes('HTTP 503 UNAVAILABLE'))).toBe(true);
    });

    it('throws for a 400 and logs the reason token, never the message or the key', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `API key not valid: ${API_KEY} at ${String(FROM.latitude)}`,
            details: [
              { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
            ],
          },
        }),
      );

      const error = await failure();
      expectLoggerIsListening(sink, 'GoogleRoutesProviderTest');
      expect(sink.some((line) => line.includes('HTTP 400 INVALID_ARGUMENT API_KEY_INVALID'))).toBe(
        true,
      );
      expectNoLeak(error.message);
      for (const line of sink) {
        expectNoLeak(line);
      }
    });

    it('says in words what to check when the key lacks the Routes API (403 PERMISSION_DENIED)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Requests to this API are blocked.',
          },
        }),
      );

      expect((await failure()).message).toMatch(/HTTP 403/);
      expect(
        sink.some(
          (line) => line.includes('PERMISSION_DENIED') && line.includes('Routes API is enabled'),
        ),
      ).toBe(true);
    });

    it('logs only enum-like tokens from an error body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, { error: { status: `denied for ${API_KEY}` } }),
      );

      await failure();
      expectLoggerIsListening(sink, 'GoogleRoutesProviderTest');
      for (const line of sink) {
        expectNoLeak(line);
      }
    });
  });
});
