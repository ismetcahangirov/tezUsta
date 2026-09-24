/**
 * Formatting the panel shares across screens. One place, so a date or a
 * size reads the same on every page.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** An ISO 8601 instant in the admin's own time zone, e.g. "24 Sept 2026, 14:05". */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** A byte count in the unit an admin can read at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
