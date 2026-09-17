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
 */
const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(locale: string, currency: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  const existing = formatters.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const created = new Intl.NumberFormat(locale, { style: 'currency', currency });
  formatters.set(key, created);
  return created;
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

  const amount = currencyFormatter(locale, pricing.currency).format(
    pricing.amountMinor / MINOR_UNITS_PER_MAJOR,
  );

  return copy.priceFrom(amount);
}
