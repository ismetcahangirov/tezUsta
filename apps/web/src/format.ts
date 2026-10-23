/**
 * Dates and money as a master in Baku reads them. A period ends at a Baku
 * calendar boundary (ADR-0046 § 5), so dates are shown in that zone whatever
 * the browser's own is.
 */
const DATE = new Intl.DateTimeFormat('az-AZ', { dateStyle: 'long', timeZone: 'Asia/Baku' });

const MONEY = new Intl.NumberFormat('az-AZ', { style: 'currency', currency: 'AZN' });

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/** Minor units (qəpik) to manat. */
export function formatMoney(minor: number): string {
  return MONEY.format(minor / 100);
}
