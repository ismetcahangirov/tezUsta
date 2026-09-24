import { reviewFailureOf } from './review-errors';

function conflict(code: string): unknown {
  return { status: 409, data: { error: { code, message: '' } } };
}

describe('reviewFailureOf', () => {
  it.each([
    'ORDER_NOT_REVIEWABLE',
    'REVIEW_WINDOW_CLOSED',
    'REVIEW_ALREADY_SUBMITTED',
    'REVIEW_ALREADY_REVEALED',
  ])('names the refusal %s by its own code', (code) => {
    expect(reviewFailureOf(conflict(code))).toBe(code);
  });

  it('does not invent a reason for a 409 it has no code for', () => {
    expect(reviewFailureOf(conflict('SOMETHING_ELSE'))).toBe('unknown');
  });

  it('reads a 422 as a validation failure', () => {
    expect(
      reviewFailureOf({ status: 422, data: { error: { code: 'VALIDATION_FAILED', message: '' } } }),
    ).toBe('validation');
  });

  it('reads a 429 as the rate limit', () => {
    expect(reviewFailureOf({ status: 429, data: {} })).toBe('rate-limited');
  });

  it('reads a transport failure as offline', () => {
    expect(reviewFailureOf({ status: 'FETCH_ERROR', error: 'TypeError' })).toBe('offline');
  });

  it('falls back to unknown for anything else', () => {
    expect(reviewFailureOf({ status: 500, data: '<html>' })).toBe('unknown');
    expect(reviewFailureOf(undefined)).toBe('unknown');
  });
});
