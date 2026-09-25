import { SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RateLimitPolicyName } from '../../infra/rate-limit/rate-limit.config';
import type { AccessTokenSubjectVerifier } from '../../infra/rate-limit/rate-limit.types';

/**
 * Metadata key {@link RateLimitGuard} reads. A string rather than a symbol
 * because `Reflector.getAllAndOverride` is keyed by value and Nest's own
 * decorators use strings; the `tezusta:` prefix keeps it from colliding with
 * a library's.
 */
export const RATE_LIMIT_METADATA = 'tezusta:rate-limit';

export interface RateLimitOptions {
  /** Which configured budget this route spends from. */
  readonly policy: RateLimitPolicyName;
  /**
   * Pulls the per-identifier subject out of the request — the phone number
   * for OTP, the session id for refresh, the email for the admin form.
   *
   * A function rather than a field path, because the subject is not always a
   * body field and because normalising it (E.164, lowercase) is the caller's
   * job: `+994 50 111 22 33` and `+994501112233` are one person and must
   * share one counter, or the limit is bypassed with a space bar.
   *
   * Returning `undefined` is legitimate and means "this request carries no
   * identifier" — a malformed body, say. The per-IP limit still applies, so
   * an unparseable request is never a free request. It is not an error here:
   * validation belongs to the Zod pipe, and a guard that threw on a missing
   * field would answer 429 for what is really a 400.
   *
   * The guard runs before authentication, so nothing on the request has been
   * verified yet. An identifier that names an **account** must therefore come
   * through `verifyAccessTokenSubject`, never from a decoded but unverified
   * claim — a subject the caller can choose is a counter the caller can spend
   * on someone else's behalf (issue #271, `rateLimitByUser`).
   */
  readonly identifier?: (
    request: FastifyRequest,
    verifyAccessTokenSubject: AccessTokenSubjectVerifier,
  ) => string | undefined;
}

/**
 * Marks a route as rate-limited under a named, configured policy.
 *
 * **A route without this decorator is not rate-limited.** That is the
 * opposite default from the authentication guard (issue #27), where the
 * absence of a decorator means "protected" and opting out is explicit, and
 * the difference is deliberate rather than an inconsistency:
 *
 * - For authorization, the safe default exists. "Require a token" is always a
 *   defensible answer for a route whose author forgot to say, and the failure
 *   mode of getting it wrong is a 401 somebody notices immediately.
 * - For rate limiting there is no such answer. Every limit is a number, and a
 *   default number would be an *arbitrary* number applied to endpoints nobody
 *   sized it for — throttling a health probe or a bulk admin list at the OTP
 *   budget, or, worse, picking something generous enough to be safe for those
 *   and therefore useless on the endpoints that matter. An arbitrary
 *   threshold is not a safe default; it is a limit that looks like protection
 *   and is not.
 *
 * So the limits are opt-in and named, and the endpoints that must carry one —
 * OTP request, OTP verify, refresh, admin sign-in — are enumerated in
 * `docs/architecture/authentication.md` § Rate limiting rather than left to
 * whoever writes the controller.
 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, options);
