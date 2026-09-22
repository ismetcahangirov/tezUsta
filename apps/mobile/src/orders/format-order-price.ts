import { deviceLocale } from '../lib/device-locale';

/**
 * How many minor units make one major unit.
 *
 * A constant rather than a reading from `Intl`, for the reason
 * `format-service-price.ts` gives in full: routing an exact monetary conversion
 * through device data means a disagreement between two phones' ICU produces a
 * wrong *amount* rather than wrong punctuation.
 */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * The currency the platform settles in.
 *
 * `Order` carries no currency of its own, unlike `ServicePricing` — the order
 * is priced by a master on this platform, in this market, and the server's
 * `PLATFORM_CURRENCY` is the matching constant. When TezUsta settles in a
 * second currency, the order contract grows a field and this constant goes
 * away; inventing the field on the client now would be inventing an API.
 */
const PLATFORM_CURRENCY = 'AZN';

/** Built once and reused: `Intl.NumberFormat` construction crosses JNI on Android. */
const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(locale: string): Intl.NumberFormat | null {
  const existing = formatters.get(locale);
  if (existing !== undefined) {
    return existing;
  }

  try {
    const created = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: PLATFORM_CURRENCY,
    });
    formatters.set(locale, created);
    return created;
  } catch {
    // The locale comes from the device rather than from the network, so this is
    // far less likely here than in `format-service-price.ts` — and it still runs
    // inside a render with no error boundary above it, where a `RangeError`
    // would take the screen down instead of the price.
    return null;
  }
}

/**
 * What the customer will pay, from what the server sent and nothing else.
 *
 * **The app never computes a price** (CLAUDE.md §11): this divides by the
 * currency's exponent and hands the result to `Intl`. There is no commission,
 * rounding or markup here that could disagree with the server.
 *
 * **Never `Intl.NumberFormat.prototype.formatToParts`.** On Apple, Hermes
 * implements it as `llvm_unreachable` — it aborts the process rather than
 * throwing, so nothing catches it and the app simply dies. Styling the currency
 * symbol apart from the digits would be an owner decision (CLAUDE.md §17) and
 * would have to be solved without that API.
 */
export function formatOrderPrice(priceMinor: number, locale = deviceLocale()): string {
  const major = priceMinor / MINOR_UNITS_PER_MAJOR;
  const formatter = currencyFormatter(locale);

  return formatter === null ? `${major.toFixed(2)} ${PLATFORM_CURRENCY}` : formatter.format(major);
}
