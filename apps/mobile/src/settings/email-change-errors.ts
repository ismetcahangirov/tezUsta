import { errorCodeOf } from '../master-jobs/error-code';
import { EMAIL_CHANGE_COPY } from './email-change-copy';

const copy = EMAIL_CHANGE_COPY.errors;

/** Which call failed: a start sends codes, a confirm checks them. */
export type EmailChangeStage = 'start' | 'confirm';

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * One message per answer the API gives (#514), so a user can tell a wrong
 * code from a taken address from a busy server.
 *
 * - `429 RATE_LIMITED`: the per-user cap on starting (sending) or on
 *   confirming (attempts). Both read as "too many tries, wait".
 * - `503`: the platform's code-sending budget refused (daily cap, hourly
 *   ceiling or circuit breaker); nothing was sent.
 * - `422 VALIDATION_FAILED` on a start: the server did not accept the
 *   address. On a confirm it can only be a code that is not digits.
 *
 * "A change already pending" is not a refusal: a new start replaces it.
 * `409 EMAIL_CHANGE_RECOVERY_PENDING`: support has a recovery open on the
 * account (#515); the owner was mailed a link to cancel it.
 */
export function emailChangeErrorMessage(stage: EmailChangeStage, error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'EMAIL_CHANGE_SAME_ADDRESS':
      return copy.sameAddress;
    case 'EMAIL_ADDRESS_TAKEN':
      return copy.taken;
    case 'EMAIL_CHANGE_CODE_INVALID':
      return copy.codeInvalid;
    case 'EMAIL_CHANGE_RECOVERY_PENDING':
      return copy.recoveryPending;
    case 'RATE_LIMITED':
      return copy.tooManyAttempts;
    case 'VALIDATION_FAILED':
      return stage === 'start' ? copy.malformed : copy.codeInvalid;
    default:
      return httpStatusOf(error) === 503 ? copy.sendCapReached : copy.generic;
  }
}
