import { envelopeOf, fieldErrorsOf, statusOf } from './addresses-errors';

function fetchBaseQueryError(status: number, body: unknown): unknown {
  return { status, data: body };
}

describe('statusOf', () => {
  it('reads the numeric status off a FetchBaseQueryError', () => {
    expect(statusOf(fetchBaseQueryError(404, {}))).toBe(404);
  });

  it('answers undefined for a transport failure, which carries a string status', () => {
    expect(statusOf({ status: 'FETCH_ERROR' })).toBeUndefined();
  });

  it('answers undefined for anything that is not an RTK Query error shape', () => {
    expect(statusOf(undefined)).toBeUndefined();
    expect(statusOf(new Error('boom'))).toBeUndefined();
  });
});

describe('envelopeOf', () => {
  it('reads the error envelope out of the response body', () => {
    const error = fetchBaseQueryError(409, {
      error: { code: 'CONFLICT', message: 'Too many addresses.', requestId: 'req-1' },
    });

    expect(envelopeOf(error)).toEqual({
      code: 'CONFLICT',
      message: 'Too many addresses.',
      requestId: 'req-1',
    });
  });

  it('answers undefined when the body carries no envelope', () => {
    expect(envelopeOf(fetchBaseQueryError(500, 'Internal Server Error'))).toBeUndefined();
  });
});

describe('fieldErrorsOf', () => {
  it('keys each issue by the field path the server named', () => {
    const error = fetchBaseQueryError(422, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed.',
        requestId: 'req-1',
        details: {
          issues: [
            { path: 'formattedAddress', message: 'Required' },
            { path: 'building', message: 'Too long' },
          ],
        },
      },
    });

    expect(fieldErrorsOf(error)).toEqual({
      formattedAddress: 'Required',
      building: 'Too long',
    });
  });

  it('answers an empty object rather than throwing when there are no issues to read', () => {
    expect(fieldErrorsOf(fetchBaseQueryError(500, {}))).toEqual({});
    expect(fieldErrorsOf(undefined)).toEqual({});
  });
});
