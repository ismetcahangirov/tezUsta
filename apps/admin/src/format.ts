/**
 * Formatting the panel shares across screens. One place, so a date or a
 * size reads the same on every page.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** An ISO 8601 instant in the admin's own time zone, e.g. "24 Sept 2026, 14:05". */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

const AZN = new Intl.NumberFormat('az-AZ', { style: 'currency', currency: 'AZN' });

/**
 * An amount in qəpik (integer minor units, as every API money field is) as
 * manat. The one money formatter in the panel — tests assert through it too,
 * because ICU renders AZN differently on Windows and on the Linux CI.
 */
export function formatMoney(minor: number): string {
  return AZN.format(minor / 100);
}

/** A byte count in the unit an admin can read at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
