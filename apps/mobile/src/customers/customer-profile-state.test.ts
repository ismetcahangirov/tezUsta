import { customerProfileState } from './customer-profile-state';

/**
 * The matrix issue #94 turns on: a 404 means "ask for a name", and nothing
 * else does.
 *
 * Kept away from a rendered component on purpose. What can go wrong here is a
 * confusion between two failures, and asserting that through a navigator and a
 * store would hide the one line that decides it.
 */
describe('customerProfileState', () => {
  const nothingYet = { hasProfile: false, isLoading: false, error: undefined };

  it('is ready when the account has a profile', () => {
    expect(customerProfileState({ ...nothingYet, hasProfile: true })).toBe('ready');
  });

  it('stays ready when a refetch fails but a profile is already known', () => {
    // The worst possible mistake would be bouncing an established customer to
    // the first-run question because their connection dropped.
    expect(
      customerProfileState({
        hasProfile: true,
        isLoading: false,
        error: { status: 'FETCH_ERROR' },
      }),
    ).toBe('ready');
  });

  it('is resolving while the first check is in flight', () => {
    expect(customerProfileState({ ...nothingYet, isLoading: true })).toBe('resolving');
  });

  it('is resolving before the query has started, not missing', () => {
    // One render, between mount and the request going out. Answering `missing`
    // here would flash the name question at every customer on every launch.
    expect(customerProfileState(nothingYet)).toBe('resolving');
  });

  it('is missing when the server said 404 — the one state that asks for a name', () => {
    expect(customerProfileState({ ...nothingYet, error: { status: 404 } })).toBe('missing');
  });

  it('is unavailable when the server failed, which is not the same as having no profile', () => {
    expect(customerProfileState({ ...nothingYet, error: { status: 500 } })).toBe('unavailable');
  });

  it('is unavailable when the request never reached the server', () => {
    // RTK Query puts a string in `status` for a transport failure. A check
    // that only compared numbers would fall through to `missing` and post a
    // profile the customer may already have.
    for (const status of ['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR']) {
      expect(customerProfileState({ ...nothingYet, error: { status } })).toBe('unavailable');
    }
  });

  it('is unavailable for an error shape it does not recognise', () => {
    expect(customerProfileState({ ...nothingYet, error: 'something went wrong' })).toBe(
      'unavailable',
    );
    expect(customerProfileState({ ...nothingYet, error: null })).toBe('unavailable');
  });
});
