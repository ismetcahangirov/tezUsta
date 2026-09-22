import { deviceLocale } from '../lib/device-locale';

/** Built once and reused: `Intl` construction crosses JNI on Android. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string): Intl.DateTimeFormat | null {
  const existing = formatters.get(locale);
  if (existing !== undefined) {
    return existing;
  }

  try {
    const created = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    formatters.set(locale, created);
    return created;
  } catch {
    // Same reasoning as `format-order-price.ts`: this runs inside a render with
    // no error boundary above it, and a `RangeError` from ICU would take the
    // list down rather than one row's date.
    return null;
  }
}

/**
 * When an order was placed, as a row in the list says it.
 *
 * **Date and time, never date alone.** A customer who ordered twice today has
 * two rows that would otherwise carry the same line, and the one they are
 * looking for is the later one. The year is included — `dateStyle: 'medium'`
 * carries it — because a list nothing is ever removed from
 * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md))
 * eventually holds two Septembers.
 *
 * **Never `Intl.DateTimeFormat.prototype.formatToParts`.** Hermes implements
 * the `Intl` part-splitting APIs as `llvm_unreachable` on Apple — the process
 * aborts rather than throwing, so no `catch` can save the screen. Styling the
 * date apart from the time would have to be solved without it, and would be an
 * owner decision in any case (CLAUDE.md §17).
 *
 * A value `Date` cannot parse comes back unchanged rather than as
 * `Invalid Date`. The server sends ISO 8601 and nothing else, so this is a
 * guard rather than a case: what it protects against is a row rendering the
 * words "Invalid Date" to a customer.
 */
export function formatOrderDate(iso: string, locale = deviceLocale()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }

  const formatter = dateFormatter(locale);
  return formatter === null ? iso : formatter.format(at);
}
