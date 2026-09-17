import type { LocalizedText } from './localized-text.types';
import { FALLBACK_LOCALE } from './localized-text.types';

/**
 * Picks the string a caller should see out of a {@link LocalizedText} map,
 * given their ordered language preferences (as returned by
 * `./accept-language.ts`'s `parseAcceptLanguage`).
 *
 * Resolution order:
 * 1. The first preference that has a non-empty translation.
 * 2. `FALLBACK_LOCALE` (`'az'`), if it has a non-empty translation.
 * 3. The first non-empty translation in the map, in whatever order
 *    `Object.values` walks it — insertion order for the string keys this
 *    type ever has.
 * 4. `''`, if nothing in the map has content at all.
 *
 * **Why step 3 exists, given the database forbids it**: the `*_name_has_fallback`
 * CHECK constraint guarantees every row has a non-empty `az` value at write
 * time, so step 2 "should" always succeed. But this function's input is a
 * plain JS value produced by `JSON.parse`-ing a JSONB column, not a value the
 * type system watched get constructed — a constraint enforced by Postgres
 * says nothing about a value already sitting in a variable, mangled by a
 * migration that ran before the constraint existed, or hand-edited through a
 * future admin tool that has its own bug. Step 3 is what keeps that gap from
 * reaching step 4.
 *
 * **Why step 4 returns `''` instead of throwing**: this function sits behind
 * a public catalogue read. Throwing on one malformed row would 500 every
 * customer's request to browse services because of a single bad row, which
 * is a worse outcome than that one row rendering as an empty label. The
 * database constraint is the place this failure is supposed to be caught —
 * at write time, loudly, for whoever inserted the bad row — not the read
 * path that every customer shares.
 *
 * A whitespace-only value (`'   '`) is treated the same as an absent one at
 * every step: it renders as nothing to a customer either way, and treating
 * it as "present" would let a translation that is empty in substance block
 * the fallback that would otherwise show real text.
 *
 * Never mutates `text`.
 */
export function resolveLocalizedText(text: LocalizedText, preferences: readonly string[]): string {
  for (const preference of preferences) {
    const candidate = text[preference];
    if (hasContent(candidate)) {
      return candidate;
    }
  }

  const fallback = text[FALLBACK_LOCALE];
  if (hasContent(fallback)) {
    return fallback;
  }

  for (const value of Object.values(text)) {
    if (hasContent(value)) {
      return value;
    }
  }

  return '';
}

/**
 * True for a string that renders as something a customer would actually see.
 * `undefined` covers a preference or locale the map has no key for at all
 * (`noUncheckedIndexedAccess` types every dynamic lookup on
 * `Record<string, string>` as possibly `undefined`, which is exactly the
 * "no translation into this language" case here — not a bug to work around).
 */
function hasContent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
