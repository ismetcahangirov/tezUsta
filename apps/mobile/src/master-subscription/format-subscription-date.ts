import { appLocale } from '../lib/app-locale';

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string): Intl.DateTimeFormat | null {
  const existing = formatters.get(locale);
  if (existing !== undefined) {
    return existing;
  }
  try {
    const created = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    formatters.set(locale, created);
    return created;
  } catch {
    // An ICU failure inside a render must not take the card down.
    return null;
  }
}

/**
 * A subscription date — a period or grace end — as the master reads it (#325).
 *
 * The day, not the time: a period ends at the minute it was bought, and "the
 * 24th" is what a master plans around. Never `formatToParts`, for the Hermes
 * reason `format-order-date.ts` gives. An unparseable value comes back as it
 * came, rather than as "Invalid Date".
 */
export function formatSubscriptionDate(iso: string, locale = appLocale()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const formatter = dateFormatter(locale);
  return formatter === null ? iso : formatter.format(at);
}
