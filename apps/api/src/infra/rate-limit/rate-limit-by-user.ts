import type { FastifyRequest } from 'fastify';

/**
 * Identifies a per-account rate-limit budget by the caller's user id.
 *
 * `RateLimitGuard` runs **before** `AuthenticationGuard` (see `app.module.ts`,
 * where the order is asserted by a test) — counting before rejecting is the
 * point of that order — so `request.actor` does not exist yet and this reads
 * the unverified claim instead.
 *
 * That is safe **for choosing a counter, and for nothing else**. The value
 * picks a bucket, not a permission: a forged `sub` moves the caller into a
 * different bucket and the request is then rejected by the guard that actually
 * verifies the signature, so it never reaches the metered resource and never
 * spends money. The per-IP half of the policy still applies throughout, which
 * is what stops the forgery from being a way to buy unlimited budget. Nothing
 * about authorization reads this.
 *
 * Shared by the two policies whose abuse is financial rather than
 * credential-guessing — `geocode` (a Maps bill, ADR-0004) and
 * `document-upload` (a storage bill, ADR-0005). It moved here from
 * `geocoding.controller.ts` when the second one arrived, which is the same
 * rule ADR-0016 applies to packages: extracted on the second consumer, not
 * before.
 */
export function rateLimitByUser(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return undefined;
  }
  const payload = header.slice('Bearer '.length).split('.')[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const sub = (claims as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    // An unparseable token carries no identifier. Returning undefined leaves
    // the per-IP limit in force, so a malformed request is never a free one.
    return undefined;
  }
}
