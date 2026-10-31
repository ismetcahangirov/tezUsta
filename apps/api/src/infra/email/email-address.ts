/**
 * Email address normalisation for sign-in (ADR-0072 § 3).
 *
 * The address is both the identity and the key every OTP lookup and rate
 * limit is an equality match on, so one person must always produce one
 * string: `Ali@Example.com ` and `ali@example.com` are the same account.
 *
 * Deliberately **no provider-specific rewriting** — no folding of Gmail dots
 * or `+tags`. That would be a guess about one provider's rules applied to
 * every address, and a wrong guess merges two real people into one account.
 * The cost, that one person can open several accounts with `+tag` addresses,
 * is accepted in ADR-0072 and bounded elsewhere (the open-orders cap, admin
 * suspension).
 */

/** RFC 5321's limit on a forward path, and the longest address accepted. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A shape check, not an RFC 5322 parser: one `@`, a non-empty local part with
 * no whitespace, and a dotted domain. Anything stricter refuses real
 * addresses; whether an address actually receives mail is proven by the code
 * arriving, which is the only check that means anything.
 *
 * Linear: no nested quantifiers over overlapping classes, and the input is
 * length-capped before it is tested (`docs/engineering/security.md`).
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export type EmailNormalisationResult =
  { readonly ok: true; readonly email: string } | { readonly ok: false };

/** Trims, lower-cases and shape-checks one address. */
export function normaliseEmail(input: string): EmailNormalisationResult {
  const email = input.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(email)) {
    return { ok: false };
  }
  return { ok: true, email };
}

/**
 * The first character of the local part and the whole domain: `a•••@gmail.com`.
 *
 * `docs/engineering/security.md` forbids a full address in a log or on a
 * screen that does not need it. A support conversation still has to confirm
 * *which* address a failure was about; the first letter and the domain are
 * enough for a person who knows their own address, and far too little to
 * identify anyone from a log.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '•••';
  }
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
