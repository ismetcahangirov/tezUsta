/**
 * The language every word on screen is written in: Azerbaijani, the API's
 * fallback too (ADR-0019).
 *
 * **The app's language, not the phone's.** Every string the app shows lives in
 * an Azerbaijani `*-copy.ts` file and there is no translation layer yet, so a
 * date, a price or a catalogue name rendered in the phone's own locale lands in
 * an Azerbaijani sentence in another language. The #399 release-build check
 * found exactly that on a phone set to English: "3:16 PM" and "Nov 20, 2026"
 * between Azerbaijani words, where `az` gives "15:16" and "20 noy 2026".
 *
 * When TezUsta picks its launch languages and adds a real i18n layer, this is
 * where the choice moves: the phone's preferred languages, matched against the
 * ones the copy exists in. Until then there is one.
 *
 * A function rather than a constant so that call sites already read the way
 * they will once the answer depends on the phone.
 */
export function appLocale(): string {
  return 'az';
}
