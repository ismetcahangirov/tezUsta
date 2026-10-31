/**
 * The longest address the API accepts — RFC 5321's limit on a forward path,
 * and the server's own cap. Anything longer is refused there with a 422, so
 * it is refused here before the request is spent.
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * `something@something.tld`, and nothing cleverer.
 *
 * **A shape check, not a validator.** The server normalises and decides
 * (ADR-0072); the client only stops an address that could never receive the
 * code from costing a rate-limited request. A stricter pattern here would
 * eventually refuse a real address the server would have taken — and the user
 * would have no way past it.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address as the server will store it: trimmed and lowercased.
 *
 * Lowercasing the whole address, local part included, is the server's rule
 * too. Doing it here as well means the address the verify screen shows, and
 * the one it sends back with the code, are byte for byte the one the code was
 * issued to.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether a normalised address is worth sending to `POST /auth/otp/request`. */
export function isPlausibleEmail(normalised: string): boolean {
  return normalised.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(normalised);
}
