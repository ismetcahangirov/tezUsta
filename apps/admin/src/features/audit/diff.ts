/** One field of an audit entry's before/after, as the panel lists it. */
export interface DiffRow {
  readonly field: string;
  /** `undefined` when the side does not mention the field. */
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** A value as readable text: strings as they are, everything else as compact JSON. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

/**
 * `before` / `after` hold only the fields an action changed (ADR-0043 § 6).
 * Listed as one row per field in either, sorted, so a creation (no before)
 * and a change read the same way.
 */
export function auditDiff(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): DiffRow[] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return fields.map((field) => ({
    field,
    before: before !== null && field in before ? displayValue(before[field]) : undefined,
    after: after !== null && field in after ? displayValue(after[field]) : undefined,
  }));
}
