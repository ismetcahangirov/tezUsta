import { randomInt } from 'node:crypto';

/**
 * Generating and rendering the one-time code. Separated from the service
 * because it is pure — no Nest, no database, no configuration object — which
 * is what lets the CSPRNG and bias properties below be tested directly
 * instead of inferred from an endpoint's behaviour.
 */

/**
 * `randomInt` draws from the same CSPRNG as `randomBytes` **and rejects
 * out-of-range draws** rather than folding them, so every value in
 * `[0, max)` is equally likely.
 *
 * Both halves matter, and the second is the one that gets lost. ADR-0008 only
 * forbids `Math.random()` — predictable output, a seeded PRNG an attacker can
 * run forward — and the usual fix is `randomBytes(4).readUInt32BE() % 1000000`,
 * which passes that bar and is still wrong: 2^32 is not a multiple of 10^6, so
 * the low codes are drawn slightly more often than the high ones. The bias is
 * small, but it is free to avoid and it is exactly the kind of "close enough"
 * that ends up in a security control. Node's `randomInt` implements rejection
 * sampling for us (see `lib/internal/crypto/random.js` in the Node source).
 */
export function generateOtpCode(length: number): string {
  if (!Number.isInteger(length) || length < 1) {
    // Unreachable through the application: `env.schema.ts` range-checks
    // `OTP_LENGTH` before it can reach here. Present because a code of length
    // zero would be an empty string that hashes and stores perfectly happily,
    // and would make every verification of that challenge succeed.
    throw new RangeError('OTP length must be a positive integer.');
  }

  let code = '';
  for (let index = 0; index < length; index += 1) {
    // Digit by digit rather than one draw over the whole range, so a code is
    // never silently shortened: `randomInt(0, 10 ** 6)` can return 42, and
    // `String(42)` is a two-digit code that is 10,000 times easier to guess
    // than the six-digit one the ADR specifies. Padding after the fact works
    // too — and is the step somebody removes later as redundant.
    code += String(randomInt(0, 10));
  }
  return code;
}

/**
 * The email's subject and plain-text body.
 *
 * **The final wording is the owner's, not this file's** (CLAUDE.md §17, and
 * "languages at launch" is still an open decision in §1). Azerbaijani, like
 * the sign-in screen that asked for it, and kept to the shortest form that
 * works everywhere until that decision lands: plain text, no link,
 * and the code at the front of the subject, because a mail notification on
 * Android and iOS shows the subject, and a code buried in the body forces the
 * user to open their inbox when they are trying to enter the app.
 *
 * Deliberately carries no address, no user id and no request id: a message
 * lands on a lock screen and sits in an inbox indefinitely, which is not a
 * place to put anything that is not already in the recipient's hands. And no
 * link at all — a code mail with a link in it is what a phishing mail looks
 * like, and users should learn that ours never has one.
 */
export function renderOtpEmail(
  code: string,
  ttlMinutes: number,
): { readonly subject: string; readonly text: string } {
  return {
    subject: `${code} — TezUsta giriş kodunuz`,
    text:
      `${code} — TezUsta giriş kodunuz. Kod ${String(ttlMinutes)} dəqiqə ərzində etibarlıdır. ` +
      'Onu heç kimə deməyin. Kodu siz istəməmisinizsə, bu məktuba məhəl qoymayın.',
  };
}
