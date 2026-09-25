import type { FastifyRequest } from 'fastify';

import type { AccessTokenSubjectVerifier } from './rate-limit.types';

const BEARER_SCHEME = 'bearer';

/**
 * Identifies a per-account rate-limit budget by the caller's user id — taken
 * **only from an access token this server signed and that has not expired**.
 *
 * `RateLimitGuard` runs **before** `AuthenticationGuard` (see `app.module.ts`,
 * where the order is asserted by a test) — counting before rejecting is the
 * point of that order — so `request.actor` does not exist yet. The guard
 * therefore hands this function `verifyAccessTokenSubject`, the same local
 * HMAC check `TokenService.verifyAccessToken` performs for the authentication
 * guard (signature, expiry, issuer, audience, claim shape; no database read),
 * and the `sub` is used only once that check has passed.
 *
 * This used to read `sub` from the decoded but unverified token, on the
 * reasoning that a forged `sub` only moves the forger into a different bucket
 * and the request is rejected afterwards anyway. The first half was the flaw:
 * the bucket a forged `sub` moves into **belongs to the account it names**,
 * and the request is counted there before authentication rejects it. So a
 * caller who could name another user's id could spend that user's budget and
 * lock them out of every route this function meters, without ever holding a
 * credential (issue #271). A per-account counter is only per-account if the
 * account is proven.
 *
 * Anything that does not verify — no header, a malformed one, a bad
 * signature, an expired token, an admin token (a different secret and
 * audience) — yields `undefined`. The request is then metered by the per-IP
 * half of the policy alone, which still applies to every request, so an
 * unverifiable token is never a free one; and it is still counted even though
 * authentication will reject it, because the guard order is unchanged.
 *
 * Shared by every policy whose per-identifier half is "per account":
 * `geocode` (a Maps bill, ADR-0004), `document-upload` (a storage bill,
 * ADR-0005), `price-range` (a compute cost against `master_services`, issue
 * #84), and order creation and transitions, offers, location reports,
 * messages, devices and reviews. It moved here from `geocoding.controller.ts`
 * when the second one arrived, which is the same rule ADR-0016 applies to
 * packages: extracted on the second consumer, not before.
 *
 * `price-range` is also the consumer where an absent identifier is the
 * **common** case rather than the edge one: `GET /services/:id/price-range`
 * is `@Public()`, so most callers carry no `Authorization` header at all and
 * fall straight through to the per-IP half of the policy.
 */
export function rateLimitByUser(
  request: FastifyRequest,
  verifyAccessTokenSubject: AccessTokenSubjectVerifier,
): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  // The same shape `AuthenticationGuard` accepts — exactly `Bearer <token>` —
  // so a header that guard would call malformed never names a bucket here.
  const parts = header.split(' ');
  const [scheme, token] = parts;
  if (
    parts.length !== 2 ||
    scheme?.toLowerCase() !== BEARER_SCHEME ||
    token === undefined ||
    token.length === 0
  ) {
    return undefined;
  }
  return verifyAccessTokenSubject(token);
}
