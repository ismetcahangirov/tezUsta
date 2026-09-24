import { isTransportFailure } from '../api/base-query';
import { errorCodeOf } from '../master-jobs/error-code';

/**
 * What went wrong with a submit or an edit, as the review screen says it.
 *
 * The four 409 codes are distinct on the server precisely so the app can say
 * a different thing for each (`reviews.errors.ts`); the rest are the shapes
 * every write in this app can meet.
 */
export type ReviewFailure =
  | 'ORDER_NOT_REVIEWABLE'
  | 'REVIEW_WINDOW_CLOSED'
  | 'REVIEW_ALREADY_SUBMITTED'
  | 'REVIEW_ALREADY_REVEALED'
  | 'validation'
  | 'rate-limited'
  | 'offline'
  | 'unknown';

const CONFLICT_CODES = new Set<string>([
  'ORDER_NOT_REVIEWABLE',
  'REVIEW_WINDOW_CLOSED',
  'REVIEW_ALREADY_SUBMITTED',
  'REVIEW_ALREADY_REVEALED',
]);

function statusOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
}

/**
 * Reads an RTK Query error into a {@link ReviewFailure}.
 *
 * **The code decides before the status does**, because a 409 without one of
 * the four codes is not a state this screen knows how to describe, and saying
 * "the window has closed" about it would be inventing a reason.
 */
export function reviewFailureOf(error: unknown): ReviewFailure {
  const code = errorCodeOf(error);
  if (code !== undefined && CONFLICT_CODES.has(code)) {
    return code as ReviewFailure;
  }

  const status = statusOf(error);
  if (status === 422 || status === 400) {
    return 'validation';
  }
  if (status === 429) {
    return 'rate-limited';
  }
  if (isTransportFailure(status)) {
    return 'offline';
  }
  return 'unknown';
}
