import { outcomeOf } from './useLocationReporter';

/**
 * How an RTK Query failure of `POST /masters/me/location` becomes the one
 * outcome the reporter acts on.
 */
describe('outcomeOf', () => {
  it('reads LOCATION_IMPLAUSIBLE as a fix to drop (issue #274)', () => {
    expect(
      outcomeOf({
        status: 422,
        data: { error: { code: 'LOCATION_IMPLAUSIBLE', message: 'Too far.' } },
      }),
    ).toBe('implausible');
  });

  it('does not read any other 422 as implausible', () => {
    expect(
      outcomeOf({ status: 422, data: { error: { code: 'VALIDATION_FAILED', message: 'No.' } } }),
    ).toBe('failed');
  });

  it('still reads a 429 as the server’s budget', () => {
    expect(outcomeOf({ status: 429, data: {} })).toBe('rate-limited');
  });

  it('reads a transport failure as an ordinary failure', () => {
    expect(outcomeOf({ status: 'FETCH_ERROR', error: 'offline' })).toBe('failed');
  });
});
