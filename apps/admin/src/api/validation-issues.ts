import type { SerializedError } from '@reduxjs/toolkit';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

/**
 * The field paths of a `VALIDATION_FAILED` answer — `details.issues[].path`
 * in the API's error envelope (the global Zod pipe writes them as dotted
 * paths, `name.az`). Only the paths: the panel says what is wrong in its own
 * words, per field, and never echoes the server's message.
 */
export function validationIssuePaths(
  error: FetchBaseQueryError | SerializedError | undefined,
): readonly string[] {
  if (error === undefined || !('status' in error) || typeof error.status !== 'number') return [];
  const { data } = error;
  if (typeof data !== 'object' || data === null || !('error' in data)) return [];
  const envelope = data.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return [];
  const { details } = envelope;
  if (typeof details !== 'object' || details === null || !('issues' in details)) return [];
  const { issues } = details;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) =>
    typeof issue === 'object' && issue !== null && 'path' in issue && typeof issue.path === 'string'
      ? [issue.path]
      : [],
  );
}
