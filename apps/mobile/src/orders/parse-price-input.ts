/**
 * The largest price the API accepts, in minor units: the same bound as a
 * master's stored price (`apps/api/src/modules/masters/masters.schema.ts`).
 */
const MAX_PRICE_MINOR = 100_000_000;

/** Whole manats, then an optional `.` or `,` and one or two qəpik digits. */
const PRICE_PATTERN = /^(\d{1,7})(?:[.,](\d{1,2}))?$/;

/**
 * What a master typed as a price, in integer minor units, or `null` when it is
 * not a price ([ADR-0060](../../../../docs/decisions/ADR-0060-inspection-price-approval.md)).
 *
 * **Parsed from the digits, never through `parseFloat`.** `45.1 * 100` is
 * `4510.000000000001` in binary floating point, and the API refuses anything
 * that is not a whole number of qəpik with a 422. Reading the manats and the
 * qəpik as two integers cannot produce a fraction at all.
 *
 * A comma is accepted as the decimal mark because that is what an Azerbaijani
 * keyboard offers. Zero is not a price (`orders_price_positive`).
 */
export function parsePriceInput(text: string): number | null {
  const match = PRICE_PATTERN.exec(text.trim());
  if (match === null) {
    return null;
  }

  const manats = Number(match[1]);
  const qepik = Number((match[2] ?? '').padEnd(2, '0'));
  const minor = manats * 100 + qepik;

  return minor > 0 && minor <= MAX_PRICE_MINOR ? minor : null;
}
