/**
 * E.164 normalisation and validation for Azerbaijani numbers.
 *
 * **Why this is not `libphonenumber-js`** (CLAUDE.md §10, and the check
 * recorded in `docs/engineering/dependency-policy.md`): that package is MIT,
 * actively maintained, and dual CJS/ESM — there is no compatibility problem
 * with it. What it offers is *multi-country* parsing, formatting and number
 * typing, and TezUsta launches in Azerbaijan only. Its metadata is ~100 KB
 * even in the `mobile` slice, and this logic is the first candidate to move to
 * `packages/validation` the day `apps/mobile` pre-checks a number before
 * asking for a code (ADR-0016) — at which point the cost lands in a React
 * Native bundle on a mid-range Android device. Re-open the question then, with
 * a second consumer to justify it; not before.
 *
 * Nest-free, config-free and Drizzle-free on purpose, so that move stays a
 * file move.
 *
 * **The rules below are transcribed from Google's libphonenumber metadata for
 * region `AZ`** (`metadata.min.json`, the artifact rather than a summary of
 * it), and are the same rules that package would apply:
 *
 * ```
 * country calling code : 994
 * national number      : 365\d{6} | (?:[124579]\d|60|88)\d{7}
 * ```
 *
 * Both branches are nine digits, which is why the length check below is a
 * single number rather than a range.
 */

/** Azerbaijan's country calling code, without the leading `+`. */
const COUNTRY_CODE = '994';

/** Every Azerbaijani national number is exactly this long. */
const NATIONAL_DIGITS = 9;

/**
 * The national significant number, exactly as libphonenumber states it for
 * `AZ`. Anchored, because a substring match would accept a number with junk
 * around it — the one failure mode a normaliser exists to prevent.
 */
const AZ_NATIONAL = /^(?:365\d{6}|(?:[124579]\d|60|88)\d{7})$/;

/**
 * Mobile prefixes, for the SMS decision specifically.
 *
 * `AZ_NATIONAL` accepts Baku landlines (`12…`) too, because they are valid
 * Azerbaijani phone numbers and this module's job is to say what a number *is*.
 * Whether sign-up should refuse a landline is a different question — an OTP
 * cannot be delivered to one, so a customer who enters their home number would
 * simply never receive a code — and it belongs to whoever owns the sign-up
 * experience, not to a normaliser. Exported so that decision can be enforced
 * at the boundary once it is made, and so it is visible rather than buried.
 */
const AZ_MOBILE_PREFIXES = ['10', '50', '51', '55', '60', '70', '77', '99'] as const;

/**
 * Reason a string is not a usable Azerbaijani number. Carried for the server
 * log and for a field-level validation message — never for a response that
 * distinguishes "not a number" from "no such user", which would be an
 * enumeration oracle (ADR-0008).
 */
export type PhoneRejection = 'empty' | 'not_azerbaijani' | 'wrong_length' | 'not_a_valid_number';

export type PhoneNormalisationResult =
  | { readonly ok: true; readonly e164: string }
  | { readonly ok: false; readonly reason: PhoneRejection };

/**
 * Everything a human might type, reduced to digits: `+994 50 123 45 67`,
 * `(050) 123-45-67`, `994501234567`, `0501234567`.
 *
 * Deliberately strips **everything** that is not a digit rather than
 * enumerating the separators people use. A normaliser that knows about spaces
 * and hyphens but not the non-breaking space a mobile keyboard inserts, or the
 * U+2011 a copy-paste carries, rejects numbers that are perfectly valid — and
 * the user has no way to see the difference.
 */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Normalises to E.164 (`+994XXXXXXXXX`) and validates against the Azerbaijani
 * numbering plan.
 *
 * Normalisation is not cosmetic. ADR-0008 requires phone numbers to be
 * "normalised to E.164 and unique among verified users" — and the uniqueness
 * constraint in the database can only hold if every write and every lookup
 * agrees on one spelling. Storing `+994501234567` and `0501234567` as two rows
 * would let one person hold two master profiles and shed a poor rating by
 * switching between them, which is the concrete harm, not the untidiness.
 *
 * Accepts, in order of how people actually type them:
 * - `+994XXXXXXXXX` / `994XXXXXXXXX` — already international
 * - `0XXXXXXXXX` — the national trunk form, `0` + nine digits
 * - `XXXXXXXXX` — bare national significant number
 *
 * Anything else is rejected rather than guessed at. Guessing a country code is
 * how a number silently becomes someone else's.
 */
export function normaliseAzerbaijaniPhone(input: string): PhoneNormalisationResult {
  const digits = digitsOnly(input);
  if (digits.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  let national: string;
  if (digits.startsWith(COUNTRY_CODE)) {
    national = digits.slice(COUNTRY_CODE.length);
  } else if (digits.startsWith('0')) {
    // The national trunk prefix. Dropped, not kept: it is a dialling
    // instruction inside the country, not part of the number.
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length !== NATIONAL_DIGITS) {
    // A number that is too long because it carries a DIFFERENT country code
    // gets its own reason, so a log line distinguishes "typo" from "this user
    // is not in Azerbaijan" — which is a product signal, not just an error.
    return {
      ok: false,
      reason:
        digits.length > NATIONAL_DIGITS && !digits.startsWith(COUNTRY_CODE)
          ? 'not_azerbaijani'
          : 'wrong_length',
    };
  }

  if (!AZ_NATIONAL.test(national)) {
    return { ok: false, reason: 'not_a_valid_number' };
  }

  return { ok: true, e164: `+${COUNTRY_CODE}${national}` };
}

/**
 * Whether an already-normalised E.164 number is on a mobile prefix, and so can
 * actually receive an SMS. See the note on {@link AZ_MOBILE_PREFIXES} — this
 * is offered, not enforced, because "may a customer sign up with a landline?"
 * is the owner's call.
 */
export function isAzerbaijaniMobile(e164: string): boolean {
  const prefix = e164.slice(`+${COUNTRY_CODE}`.length, `+${COUNTRY_CODE}`.length + 2);
  return AZ_MOBILE_PREFIXES.some((mobilePrefix) => mobilePrefix === prefix);
}

/**
 * The last two digits, with everything before them masked: `+994******67`.
 *
 * `docs/engineering/security.md` forbids logging a full phone number, and
 * ADR-0008 repeats it — "logs are read by more people than expect to see
 * them". But a support conversation still needs to confirm *which* number a
 * failure was about, and an opaque id cannot do that over the phone. Two
 * digits is enough for a person holding their own handset to recognise, and
 * far too little to identify anyone from a log.
 */
export function maskPhone(e164: string): string {
  const visible = e164.slice(-2);
  return `+${COUNTRY_CODE}${'*'.repeat(NATIONAL_DIGITS - 2)}${visible}`;
}
