import { formatServicePrice } from './format-service-price';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';

/**
 * A fixed locale, so these assertions test this function rather than the CI
 * machine's default.
 *
 * Nothing here asserts a whole formatted string against a literal, and nothing
 * recomputes the function's own output to compare against — either would pass
 * for any output the function produced. Device output legitimately varies with
 * the platform's ICU version; what must hold is the *meaning* of the string.
 */
const LOCALE = 'az-AZ';

describe('formatServicePrice', () => {
  it('says the price comes after the visit for an inspection-priced service', () => {
    expect(formatServicePrice({ kind: 'inspection' }, LOCALE)).toBe(copy.priceAfterInspection);
  });

  it('treats the amount as minor units — 2500 is twenty-five, not two and a half thousand', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
      LOCALE,
    );

    expect(formatted).toContain('25');
    expect(formatted).not.toContain('2500');
    expect(formatted).not.toContain('2 500');
  });

  it('keeps minor units that do not make a whole major unit', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 2550, currency: 'AZN' },
      LOCALE,
    );

    expect(formatted).toMatch(/25[.,]50/);
  });

  it('qualifies a fixed amount rather than presenting it as the price', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
      LOCALE,
    );

    // The master who accepts sets the real figure (ADR-0010), so a bare number
    // would be a promise the platform cannot keep.
    expect(formatted).not.toMatch(/^25/);
    expect(formatted.length).toBeGreaterThan('25,00 ₼'.length);
  });

  it('uses the currency the server sent rather than assuming AZN', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 1000, currency: 'USD' },
      'en-US',
    );

    expect(formatted).toContain('10');
    expect(formatted).toContain('$');
  });

  /**
   * `currency` is typed `string` and arrives from the network with nothing
   * having parsed it — the RTK Query response type is an assertion, not a
   * check. `Intl.NumberFormat` throws a `RangeError` for a malformed code, and
   * this function runs inside the render of every list row with no error
   * boundary anywhere in the app: unguarded, one bad row takes down the whole
   * screen.
   */
  it.each(['AZNX', '', 'not a currency'])(
    'renders an amount instead of throwing for the malformed currency %p',
    (currency) => {
      const formatted = formatServicePrice({ kind: 'fixed', amountMinor: 2500, currency }, LOCALE);

      expect(formatted).toContain('25');
    },
  );
});
