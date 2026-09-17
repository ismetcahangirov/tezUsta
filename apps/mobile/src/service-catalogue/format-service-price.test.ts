import { formatServicePrice } from './format-service-price';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';

/**
 * A fixed locale, so these assertions test this function rather than the CI
 * machine's default. Device output legitimately varies — see the comment in
 * `format-service-price.ts` — which is why nothing here asserts a full
 * formatted string against a hardcoded literal.
 */
const LOCALE = 'az-AZ';

describe('formatServicePrice', () => {
  it('says the price comes after the visit for an inspection-priced service', () => {
    expect(formatServicePrice({ kind: 'inspection' }, LOCALE)).toBe(copy.priceAfterInspection);
  });

  it('renders a fixed price as a reference figure, not as the price', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 2500, currency: 'AZN' },
      LOCALE,
    );

    expect(formatted).toBe(
      copy.priceFrom(
        new Intl.NumberFormat(LOCALE, {
          style: 'currency',
          currency: 'AZN',
        }).format(25),
      ),
    );
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

  it('keeps the minor units that are not a whole major unit', () => {
    const formatted = formatServicePrice(
      { kind: 'fixed', amountMinor: 2550, currency: 'AZN' },
      LOCALE,
    );

    expect(formatted).toContain('25');
    expect(formatted).toContain('50');
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
   * The one `resolvedOptions` key that Hermes-Android, Hermes-Apple and Node
   * all agree on. Asserting the whole object would pass in Jest and be wrong
   * on every device — the three implementations emit different key sets.
   */
  it('formats AZN to two decimal places, which is the exponent the server assumes', () => {
    expect(
      new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'AZN' }).resolvedOptions()
        .maximumFractionDigits,
    ).toBe(2);
  });
});
