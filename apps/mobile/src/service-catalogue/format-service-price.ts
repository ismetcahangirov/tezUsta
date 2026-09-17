import type { ServicePricing } from '@tezusta/types';

import { deviceLocale } from '../lib/device-locale';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';

/**
 * How many minor units make one major unit.
 *
 * **A constant, deliberately not read from `Intl`.**
 * `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits` does return
 * 2 for AZN on both engines, but it gets there differently — Android asks the
 * device's live ICU, Apple looks the code up in a table frozen into Hermes —
 * and routing an exact monetary conversion through device data means a
 * disagreement would produce a wrong *amount*, not merely wrong punctuation.
 * The exponent is a property of the currency the platform settles in, which
 * is a product fact; `PLATFORM_CURRENCY` on the server is the matching one.
 */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * `Intl.NumberFormat` construction crosses JNI on Android, so a list of thirty
 * rows must not build thirty of them. Keyed by locale and currency because
 * either can change and neither changes often.
 *
 * It is bounded in practice rather than by a cap: the locale is the device's
 * one locale and the currency is the one the platform settles in, so the map
 * holds about one entry. It stays bounded because a code `Intl` rejects is
 * never cached — see the `catch` below.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(locale: string, currency: string): Intl.NumberFormat | null {
  const key = `${locale}|${currency}`;
  const existing = formatters.get(key);
  if (existing !== undefined) {
    return existing;
  }

  try {
    const created = new Intl.NumberFormat(locale, { style: 'currency', currency });
    formatters.set(key, created);
    return created;
  } catch {
    // `currency` arrives from the network and is typed `string`; RTK Query's
    // response type is an assertion, not a parse, so nothing has checked it.
    // `new Intl.NumberFormat(..., { currency: 'AZNX' })` throws a RangeError,
    // and this runs inside the render of every list row with no error boundary
    // anywhere in the app — one malformed row would take down the whole
    // screen rather than the row. Falling back keeps the number readable and
    // keeps the screen alive.
    //
    // The key is deliberately NOT cached on this path: caching failures would
    // let a server sending varied junk grow the map without bound.
    return null;
  }
}

/**
 * The fallback when a currency code is not one `Intl` recognises: the amount,
 * then the code as it arrived. Ugly on purpose — it is visibly not a designed
 * price, which is the right signal for data the server should not have sent.
 */
function formatWithoutIntl(major: number, currency: string): string {
  return `${major.toFixed(2)} ${currency}`;
}

/**
 * Renders what a service costs, from what the server sent and nothing else.
 *
 * **The app never computes a price** (CLAUDE.md §11). This divides by the
 * currency's exponent to get from minor units to major and hands the result to
 * `Intl`; there is no arithmetic here that could disagree with the server, and
 * no commission, rounding or markup of any kind.
 *
 * A fixed amount reads as "from X" rather than as the price, because it is a
 * reference figure — the authoritative number comes from the master who
 * accepts ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)).
 *
 * **Never use `Intl.NumberFormat.prototype.formatToParts` here.** On Apple,
 * Hermes implements it as `llvm_unreachable` — it aborts the process rather
 * than throwing, so nothing catches it and the app simply dies. If the design
 * ever wants the currency symbol styled apart from the digits, that is an
 * owner question (CLAUDE.md §17) and it has to be solved without that API.
 *
 * Output is not byte-identical across devices: Android formats from the
 * device's own ICU, so two phones on different OS versions can space the same
 * price differently. That is correct behaviour and the reason a screenshot
 * test of a price would be a flake, not a check.
 */
export function formatServicePrice(pricing: ServicePricing, locale = deviceLocale()): string {
  if (pricing.kind === 'inspection') {
    return copy.priceAfterInspection;
  }

  const major = pricing.amountMinor / MINOR_UNITS_PER_MAJOR;
  const formatter = currencyFormatter(locale, pricing.currency);
  const amount =
    formatter === null ? formatWithoutIntl(major, pricing.currency) : formatter.format(major);

  return copy.priceFrom(amount);
}
