/**
 * AZN on the panel. The API speaks integer minor units (qəpik); an admin
 * types manats. The conversion is string arithmetic, never `x * 100`:
 * `4.35 * 100` is `434.99999999999994` in binary floating point, and a
 * `Math.round` over it only hides the problem until a value it rounds the
 * wrong way.
 */

const AZN = new Intl.NumberFormat('az-AZ', { style: 'currency', currency: 'AZN' });

/** The one way the panel shows an amount. Tests assert through this, never a literal. */
export function formatAzn(minor: number): string {
  // Display only: dividing an integer by 100 and formatting to two places is
  // exact for every value the API can hold (≤ 10 000 000 qəpik).
  return AZN.format(minor / 100);
}

/** Smallest and largest reference price the API accepts, in qəpik (1 qəpik – 100 000 AZN). */
export const MIN_PRICE_MINOR = 1;
export const MAX_PRICE_MINOR = 10_000_000;

/** Whole manats, then up to two decimals after a point or a comma (`45`, `45.5`, `45,50`). */
const AMOUNT = /^(\d{1,6})(?:[.,](\d{1,2}))?$/;

export type ParsedAmount =
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly reason: 'format' | 'range' };

/** Parses what an admin typed as manats into qəpik, exactly. */
export function parseAznToMinor(input: string): ParsedAmount {
  const match = AMOUNT.exec(input.trim());
  if (match === null) return { ok: false, reason: 'format' };
  const [, whole = '0', fraction = ''] = match;
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (minor < MIN_PRICE_MINOR || minor > MAX_PRICE_MINOR) return { ok: false, reason: 'range' };
  return { ok: true, minor };
}

/** qəpik → the text an edit form starts from (`4550` → `"45.50"`). */
export function minorToAznInput(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const fraction = minor % 100;
  return `${String(whole)}.${String(fraction).padStart(2, '0')}`;
}
