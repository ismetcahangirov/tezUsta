import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  offerIdParamsSchema,
  offerResponseSchema,
} from '../src/modules/masters/offers/master-offers.schema';

/**
 * The offer-response schemas (issue #101).
 *
 * Two tiny schemas, and the whole point of both is what they **refuse**. The
 * accept and decline bodies are empty because every fact the server needs is
 * the server's own — who is responding comes from the actor, which offer from
 * the path, the price from the accepting master's stored row (ADR-0013) — so
 * `.strict()` is the mass-assignment guard on the most consequential write in
 * the backend. A silently dropped `priceMinor` would leave a client believing
 * it had set the price of a job.
 */
describe('the master offer schemas', () => {
  describe('the offer id path parameter', () => {
    it('accepts a uuid', () => {
      const offerId = randomUUID();
      expect(offerIdParamsSchema.parse({ offerId })).toEqual({ offerId });
    });

    it.each(['', 'not-a-uuid', '../../etc/passwd', '00000000-0000-0000-0000'])(
      'refuses %j',
      (offerId) => {
        expect(offerIdParamsSchema.safeParse({ offerId }).success).toBe(false);
      },
    );

    it('refuses an unknown key alongside the id', () => {
      const result = offerIdParamsSchema.safeParse({
        offerId: randomUUID(),
        masterId: randomUUID(),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('the accept and decline body', () => {
    it('accepts an empty object', () => {
      expect(offerResponseSchema.parse({})).toEqual({});
    });

    it.each([
      { priceMinor: 1 },
      { status: 'ACCEPTED' },
      { masterId: '00000000-0000-4000-8000-000000000000' },
      { orderId: '00000000-0000-4000-8000-000000000000' },
      { acceptedAt: '2026-01-01T00:00:00.000Z' },
    ])('refuses a body that names %j', (body) => {
      expect(offerResponseSchema.safeParse(body).success).toBe(false);
    });
  });
});
