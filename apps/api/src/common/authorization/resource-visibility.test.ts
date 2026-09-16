import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../errors/not-found.error';
import { requireVisibleOrNotFound } from './resource-visibility';

interface Order {
  readonly id: string;
  readonly customerId: string;
}

const ORDER: Order = { id: 'order-1', customerId: 'customer-1' };

describe('requireVisibleOrNotFound', () => {
  it('returns the resource when the predicate accepts it', () => {
    expect(requireVisibleOrNotFound(ORDER, (order) => order.customerId === 'customer-1')).toBe(
      ORDER,
    );
  });

  it('throws NotFoundError when the resource does not exist', () => {
    expect(() => requireVisibleOrNotFound(undefined, () => true)).toThrow(NotFoundError);
    expect(() => requireVisibleOrNotFound(null, () => true)).toThrow(NotFoundError);
  });

  it("throws NotFoundError — not a 403 — when the resource exists but is not the caller's", () => {
    expect(() =>
      requireVisibleOrNotFound(ORDER, (order) => order.customerId === 'someone-else'),
    ).toThrow(NotFoundError);
  });

  it('throws an error indistinguishable from the missing-resource one, field by field', () => {
    // The security property of the helper, asserted on the error object rather
    // than on an HTTP response so it holds for every future call site,
    // including ones that never go through the exception filter. A `details`
    // payload added to either path — "orderId not visible", say — reinstates
    // the existence oracle, and this comparison is what catches that.
    const missing = captureError(() => requireVisibleOrNotFound(undefined, () => true));
    const notYours = captureError(() => requireVisibleOrNotFound(ORDER, () => false));

    expect(notYours.code).toBe(missing.code);
    expect(notYours.message).toBe(missing.message);
    expect(notYours.status).toBe(missing.status);
    expect(notYours.details).toBeUndefined();
    expect(missing.details).toBeUndefined();
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('never evaluates the predicate for a resource that does not exist', () => {
    // Otherwise every call site's predicate would need its own null check, and
    // the first one to forget it turns a 404 into a 500 — which is itself a
    // distinguishable response.
    let evaluated = false;
    expect(() =>
      requireVisibleOrNotFound(null, () => {
        evaluated = true;
        return true;
      }),
    ).toThrow(NotFoundError);
    expect(evaluated).toBe(false);
  });
});

function captureError(run: () => unknown): NotFoundError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected requireVisibleOrNotFound to throw.');
}
