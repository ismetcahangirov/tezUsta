import { readLocationPermission } from './location-permission';

/**
 * The three answers the app acts on (issue #171).
 *
 * Worth its own tests for one reason: Android reports `canAskAgain: true`
 * alongside a permission it has already granted, so a reducer that checked
 * askability first would prompt a master whose location already works.
 */
describe('reading a location permission', () => {
  it('is granted when the platform granted it', () => {
    expect(readLocationPermission({ granted: true, canAskAgain: false })).toBe('granted');
  });

  it('is still granted when the platform also says it could ask again', () => {
    expect(readLocationPermission({ granted: true, canAskAgain: true })).toBe('granted');
  });

  it('is askable before the first refusal', () => {
    expect(readLocationPermission({ granted: false, canAskAgain: true })).toBe('askable');
  });

  it('is blocked once the platform will not ask again', () => {
    expect(readLocationPermission({ granted: false, canAskAgain: false })).toBe('blocked');
  });
});
