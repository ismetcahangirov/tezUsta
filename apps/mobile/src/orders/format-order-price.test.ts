import { formatOrderPrice } from './format-order-price';

/**
 * A fixed locale, so these assertions test this function rather than the CI
 * machine's default. Nothing here compares a whole formatted string against a
 * literal: device output legitimately varies with the platform's ICU version,
 * and what must hold is the *meaning* of the string, not its spacing.
 */
const LOCALE = 'az-AZ';

describe('formatOrderPrice', () => {
  it('treats the amount as minor units — 2500 is twenty-five manat, not two and a half thousand', () => {
    const formatted = formatOrderPrice(2500, LOCALE);

    expect(formatted).toContain('25');
    expect(formatted).not.toContain('2500');
    expect(formatted).not.toContain('2 500');
  });

  it('keeps minor units that do not make a whole major unit', () => {
    expect(formatOrderPrice(2550, LOCALE)).toMatch(/25[.,]50/);
  });

  it('says which currency it is', () => {
    expect(formatOrderPrice(2500, LOCALE)).toMatch(/AZN|₼/);
  });

  /**
   * A price the platform has not frozen yet is `null` on the order and never
   * reaches this function — but zero is a real amount and must not be dressed
   * up as an absent one.
   */
  it('formats zero as an amount rather than as nothing', () => {
    expect(formatOrderPrice(0, LOCALE)).toContain('0');
  });

  it('survives a locale the platform does not recognise', () => {
    expect(formatOrderPrice(2500, 'not-a-locale')).toContain('25');
  });
});
