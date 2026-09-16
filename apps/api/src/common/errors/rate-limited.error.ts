import { AppError } from './app-error';
import { ERROR_CODES } from './error-codes.types';

/**
 * The key under which the retry hint travels in the error envelope's
 * `details`.
 *
 * Exported and shared with {@link AllExceptionsFilter} rather than spelled
 * twice: the filter turns this value into the `Retry-After` header, so a
 * rename in one place and not the other would drop the header silently and
 * only on the 429 path, which is the path nobody exercises by hand.
 */
export const RETRY_AFTER_DETAIL_KEY = 'retryAfterSeconds';

/**
 * A single, unvarying message. Not a style choice — this error is thrown by
 * the guard in front of the OTP and sign-in endpoints, where
 * `docs/architecture/authentication.md` § Rate limiting requires responses to
 * be **identical for known and unknown identifiers**. A message that said
 * "too many codes sent to this number" versus "too many requests" would turn
 * the 429 itself into the user-enumeration oracle the rest of the flow is
 * careful not to be.
 *
 * It also says nothing about which dimension was exceeded. Telling a caller
 * "your IP is limited" rather than "this number is limited" is free
 * reconnaissance about how the limiter is keyed.
 */
const RATE_LIMITED_MESSAGE = 'Too many requests. Please try again later.';

/**
 * 429, with a retry hint a client can act on.
 *
 * The hint is in `details` as well as in the header because the mobile client
 * reads the JSON envelope, not raw headers, through its RTK Query error
 * handling (ADR-0017) — a header-only hint would be present and unused. It
 * carries no information about the caller beyond how long they must wait,
 * which they already know they must do.
 */
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(ERROR_CODES.RATE_LIMITED, RATE_LIMITED_MESSAGE, 429, {
      [RETRY_AFTER_DETAIL_KEY]: retryAfterSeconds,
    });
    this.name = 'RateLimitedError';
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }
}
