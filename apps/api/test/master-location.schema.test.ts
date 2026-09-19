import { describe, expect, it } from 'vitest';

import { reportLocationSchema } from '../src/modules/masters/master-location.schema';

/**
 * The boundary schema for `POST /masters/me/location` (issue #98), on its own
 * so the cases that matter are cheap to enumerate.
 *
 * Coordinates are the one body in this API where a value that is merely
 * *plausible* is dangerous: a wrong-but-in-range number does not fail
 * anywhere downstream — it silently moves a master, and dispatch then offers
 * work based on it. So this file cares less about the happy path than about
 * everything that must not be quietly accepted and coerced into one.
 */
describe('reportLocationSchema (issue #98)', () => {
  it('accepts a position in Baku', () => {
    const parsed = reportLocationSchema.parse({ latitude: 40.409264, longitude: 49.867092 });
    expect(parsed).toEqual({ latitude: 40.409264, longitude: 49.867092 });
  });

  it('accepts the exact bounds of the planet, in both directions', () => {
    expect(reportLocationSchema.safeParse({ latitude: 90, longitude: 180 }).success).toBe(true);
    expect(reportLocationSchema.safeParse({ latitude: -90, longitude: -180 }).success).toBe(true);
  });

  it.each([
    ['latitude above the pole', { latitude: 90.0001, longitude: 49.8 }],
    ['latitude below the pole', { latitude: -91, longitude: 49.8 }],
    ['longitude past the antimeridian', { latitude: 40.4, longitude: 180.5 }],
    ['longitude before the antimeridian', { latitude: 40.4, longitude: -181 }],
  ])('rejects %s', (_case, body) => {
    expect(reportLocationSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['a stringified number', { latitude: '40.4', longitude: '49.8' }],
    ['null', { latitude: null, longitude: 49.8 }],
    ['NaN', { latitude: Number.NaN, longitude: 49.8 }],
    ['Infinity', { latitude: 40.4, longitude: Number.POSITIVE_INFINITY }],
  ])('rejects %s rather than coercing it', (_case, body) => {
    // A client that stringifies its payload has a bug, and coercing hides the
    // day it starts sending "40,4" instead of "40.4". NaN and Infinity are
    // here because they are `typeof 'number'` and would otherwise sail past a
    // naive check straight into ST_MakePoint.
    expect(reportLocationSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['latitude', { longitude: 49.8 }],
    ['longitude', { latitude: 40.4 }],
    ['both', {}],
  ])('rejects a body missing %s', (_case, body) => {
    // Half a coordinate is not a partial update here — there is nothing to
    // merge it into. A report either says where the master is or it says
    // nothing.
    expect(reportLocationSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an unknown key rather than dropping it', () => {
    // `.strict()`. An app that believes it is sending accuracy and is not
    // looks identical to one that is, and the first symptom would be a
    // dispatch decision nobody could explain.
    const result = reportLocationSchema.safeParse({
      latitude: 40.4,
      longitude: 49.8,
      accuracy: 12,
    });
    expect(result.success).toBe(false);
  });

  it('rejects the lat/lng spelling a client might guess at', () => {
    expect(reportLocationSchema.safeParse({ lat: 40.4, lng: 49.8 }).success).toBe(false);
  });
});
