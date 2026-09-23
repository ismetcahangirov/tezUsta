import { deviceLocale } from '../lib/device-locale';

/** Built once per locale and reused: `Intl` construction crosses JNI on Android. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(locale: string): Intl.DateTimeFormat | null {
  const existing = formatters.get(locale);
  if (existing !== undefined) {
    return existing;
  }

  try {
    const created = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
    formatters.set(locale, created);
    return created;
  } catch {
    // The reason `format-order-date.ts` gives: this runs inside a list row's
    // render, and a `RangeError` from ICU must cost one timestamp, not the list.
    return null;
  }
}

/**
 * When a message was written, as its bubble says it: the time of day only.
 *
 * **No date** ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 * A conversation lives from an accept to the end of one job — hours, not
 * weeks — so every message in it is on the order's own day, and a date on
 * every bubble would be the same words repeated down the screen. A transcript
 * that does span midnight is read in order, which says which day is which.
 *
 * Never `formatToParts`, for the reason `format-order-date.ts` gives (Hermes
 * aborts on it on Apple). A value `Date` cannot parse comes back unchanged.
 */
export function formatMessageTime(iso: string, locale = deviceLocale()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }

  const formatter = timeFormatter(locale);
  return formatter === null ? iso : formatter.format(at);
}
