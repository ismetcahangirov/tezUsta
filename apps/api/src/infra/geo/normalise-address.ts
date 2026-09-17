/**
 * Turns free-typed address text into the key the geocode cache is stored under.
 *
 * **The cache is the single largest lever on the Google Maps bill**
 * (`docs/architecture/location-services.md`): the same Baku addresses recur
 * constantly, and without normalisation the invoice grows with traffic rather
 * than with distinct addresses. `"28 May küç. 5"`, `"28 May küç. 5 "` and
 * `"28 MAY KÜÇ. 5"` are one address and must be one row.
 *
 * The goal here is a key that is **stable and collision-free**, not one that is
 * linguistically correct. Those pull in different directions exactly once, and
 * the dotted/dotless I is where.
 */

/**
 * `toLowerCase()`, deliberately, and **not** `toLocaleLowerCase('az')`.
 *
 * Azerbaijani (like Turkish) treats I/ı and İ/i as two separate letters, so the
 * locale-aware mapping is the linguistically correct one:
 *
 * ```
 * 'I'.toLowerCase()              → 'i'
 * 'I'.toLocaleLowerCase('az')    → 'ı'
 * 'İ'.toLowerCase()              → 'i' + U+0307 (combining dot above)
 * 'İ'.toLocaleLowerCase('az')    → 'i'
 * ```
 *
 * A cache key does not want correctness, it wants determinism. ECMA-262
 * specifies `toLowerCase` against the **locale-insensitive** Unicode default
 * case mappings, so it produces the same bytes on every conformant engine
 * regardless of the host's locale or the ICU data in the container image. The
 * locale form is defined by ECMA-402 against a locale database, and a key whose
 * value depends on which ICU build shipped in the base image is a key that
 * silently splits a cache in half the day the image is rebuilt.
 *
 * The cost is one missed cache hit: a customer who types a capital `I` where
 * Azerbaijani wants `ı` lands in a different bucket. That is a hit-rate loss
 * measured in fractions of a percent, not a wrong answer — the address still
 * geocodes, it just pays for the call.
 */
function foldCase(value: string): string {
  return value.toLowerCase();
}

/**
 * NFC, not NFKC and not NFD.
 *
 * Azerbaijani text arrives from several keyboards and input methods, and the
 * same visible `ö` may be one code point or `o` plus a combining diaeresis.
 * Canonical composition (NFC) collapses those to one representation, which is
 * the whole point before hashing text into a key. NFKC would go further and
 * fold *compatibility* variants — ligatures, full-width forms — which conflates
 * things that are not the same address; NFD decomposes, which is the wrong
 * direction for a compact key.
 *
 * Applied **before** case folding, because case mapping operates on code points
 * and a decomposed sequence folds differently from a composed one.
 */
const NORMALISATION_FORM = 'NFC';

/**
 * Everything that is not a letter, a number or a space.
 *
 * Punctuation in an address is decoration: `"28 May küç., 5"`, `"28 May küç 5"`
 * and `"28-May küç. 5"` are the same door. `\p{L}` and `\p{N}` are used rather
 * than `\w`, which is ASCII-only and would delete every Azerbaijani letter with
 * a diacritic — turning `"küçə"` into `"k"` and making the cache key collide
 * with every other address on the street.
 */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

const WHITESPACE_RUN = /\s+/gu;

/**
 * The cache key for an address. Pure, total, and never throws — a key that
 * could fail would put the cache in the error path of every lookup.
 *
 * Order matters: normalise, then fold case, then strip punctuation, then
 * collapse whitespace. Stripping before collapsing is what makes `"küç., 5"`
 * and `"küç. 5"` agree, since removing the comma leaves two spaces behind.
 */
export function normaliseAddress(raw: string): string {
  return foldCase(raw.normalize(NORMALISATION_FORM))
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}
