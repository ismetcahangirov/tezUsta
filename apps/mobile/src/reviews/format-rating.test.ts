import { formatRatingAverage, presentPartyRating } from './format-rating';
import { REVIEWS_COPY as copy } from './reviews-copy';

/**
 * Fixed locales, so these test the function rather than the machine. Nothing
 * compares against a literal decimal: the separator is read from the platform's
 * own ICU, which is what the helper is supposed to follow.
 */
const LOCALE = 'az-AZ';

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')
      ?.value ?? '.'
  );
}

describe('formatRatingAverage', () => {
  it('writes the decimal the way the locale does', () => {
    for (const locale of [LOCALE, 'en-US', 'ru-RU']) {
      expect(formatRatingAverage(4.5, locale)).toBe(`4${decimalSeparator(locale)}5`);
    }
  });

  it('shows one decimal, rounding the API’s two', () => {
    const separator = decimalSeparator(LOCALE);
    expect(formatRatingAverage(4.67, LOCALE)).toBe(`4${separator}7`);
    expect(formatRatingAverage(4.64, LOCALE)).toBe(`4${separator}6`);
  });

  it('keeps the decimal on a whole number, so every average reads alike', () => {
    expect(formatRatingAverage(5, LOCALE)).toBe(`5${decimalSeparator(LOCALE)}0`);
  });

  it('survives a locale the platform does not recognise', () => {
    expect(formatRatingAverage(4.67, 'not-a-locale')).toMatch(/^4[.,]7$/);
  });
});

describe('presentPartyRating', () => {
  it('says "no ratings yet" for a null average — never zero (ADR-0042 § 6)', () => {
    const line = presentPartyRating({ ratingAverage: null, ratingCount: 0 }, LOCALE);

    expect(line).toBe(copy.rating.none);
    expect(line).not.toMatch(/0/);
  });

  it('reads a count of zero as no ratings, whatever average came with it', () => {
    expect(presentPartyRating({ ratingAverage: 4, ratingCount: 0 }, LOCALE)).toBe(copy.rating.none);
  });

  it('shows the average with its count', () => {
    expect(presentPartyRating({ ratingAverage: 4.67, ratingCount: 12 }, LOCALE)).toBe(
      copy.rating.summary(formatRatingAverage(4.67, LOCALE), 12),
    );
  });
});
