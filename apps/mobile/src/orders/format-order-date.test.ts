import { formatOrderDate } from './format-order-date';

/**
 * A fixed locale, for the reason `format-order-price.test.ts` gives: these
 * assertions are about this function, not about the CI machine's default. And
 * nothing compares a whole formatted string to a literal — ICU spells a month
 * differently between platform versions, and what must hold is the meaning.
 */
const LOCALE = 'en-GB';

describe('formatOrderDate', () => {
  it('names the day and the year, so two Septembers cannot read alike', () => {
    const formatted = formatOrderDate('2026-09-22T14:30:00.000Z', LOCALE);

    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/22|23/);
  });

  it('carries the time, so two orders placed the same day are told apart', () => {
    const morning = formatOrderDate('2026-09-22T06:05:00.000Z', LOCALE);
    const evening = formatOrderDate('2026-09-22T19:45:00.000Z', LOCALE);

    expect(morning).not.toBe(evening);
  });

  it('never renders the words a bad date would produce', () => {
    expect(formatOrderDate('not-a-date', LOCALE)).not.toContain('Invalid');
    expect(formatOrderDate('not-a-date', LOCALE)).toBe('not-a-date');
  });

  it('survives a locale the platform does not recognise', () => {
    expect(formatOrderDate('2026-09-22T14:30:00.000Z', 'not-a-locale')).toContain('2026');
  });
});
