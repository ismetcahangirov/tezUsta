import type { PartyRating } from '@tezusta/types';

import { deviceLocale } from '../lib/device-locale';
import { REVIEWS_COPY as copy } from './reviews-copy';

/**
 * One decimal: the API sends the average to two (issue #225), but "4,67" on a
 * phone is precision nobody can use about a plumber — and every rating surface
 * people know shows one.
 */
const FRACTION_DIGITS = 1;

const formatters = new Map<string, Intl.NumberFormat>();

function averageFormatter(locale: string): Intl.NumberFormat | null {
  const existing = formatters.get(locale);
  if (existing !== undefined) {
    return existing;
  }
  try {
    const created = new Intl.NumberFormat(locale, {
      minimumFractionDigits: FRACTION_DIGITS,
      maximumFractionDigits: FRACTION_DIGITS,
    });
    formatters.set(locale, created);
    return created;
  } catch {
    // The same reasoning as `format-order-price.ts`: this runs inside a
    // render, and a `RangeError` from ICU must cost the number, not the screen.
    return null;
  }
}

/**
 * An average rating as the device's locale writes a decimal — "4,7" in
 * Azerbaijani, "4.7" in English (issue #228).
 */
export function formatRatingAverage(average: number, locale = deviceLocale()): string {
  const formatter = averageFormatter(locale);
  return formatter === null ? average.toFixed(FRACTION_DIGITS) : formatter.format(average);
}

/**
 * A party's rating as one line: the average with its count, or — with no
 * revealed reviews — the words for "no ratings yet". **Never "0"** (ADR-0042
 * § 6): no reviews is not a bad score, and a zero would read as one.
 *
 * `ratingAverage` is null exactly when there are no reviews; a count of zero
 * with a number beside it would be a contract violation, and is read as no
 * ratings rather than trusted.
 */
export function presentPartyRating(rating: PartyRating, locale = deviceLocale()): string {
  if (rating.ratingAverage === null || rating.ratingCount === 0) {
    return copy.rating.none;
  }
  return copy.rating.summary(formatRatingAverage(rating.ratingAverage, locale), rating.ratingCount);
}
