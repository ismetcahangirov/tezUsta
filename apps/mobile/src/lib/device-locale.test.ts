import { deviceLocale } from './device-locale';

describe('deviceLocale', () => {
  it('returns a BCP 47 tag', () => {
    expect(deviceLocale()).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
  });

  it('falls back to Azerbaijani rather than throwing when Intl is unavailable', () => {
    const real = global.Intl;
    // @ts-expect-error — deliberately removing a global the type says is there,
    // which is exactly the situation the fallback exists for.
    delete global.Intl;

    try {
      expect(deviceLocale()).toBe('az');
    } finally {
      global.Intl = real;
    }
  });
});
