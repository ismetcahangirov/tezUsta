# ADR-0065 — The mobile app's typeface is Cahan Serif

- **Status:** **Accepted**
- **Date:** 2026-10-25
- **Decided by:** Project owner. On 25 October 2026 the owner supplied the Cahan Serif family and asked that every piece of text in the app use it, the logo excepted ("tətbiqdə istifadə olunacaq bütün mətnlər logonu çıxmaq şərti ilə bu fontdan istifadə olunacaq"), and then that the italics be added so they can be used where needed ("italic olanı da fayllara əlavə et, lazım olsa istifadə edilsin").
- **Context:** Issue #450.
- **Supersedes:** the typeface clause of [ADR-0011](ADR-0011-design-system.md) (Anybody), for `apps/mobile` only. The rest of ADR-0011 and ADR-0048 stands.

## Context

ADR-0011 took Anybody from the owner's reference and shipped it through
`@expo-google-fonts/anybody`. The owner has now supplied a typeface of their
own: Cahan Serif, 14 static TTFs (Light to Black, each with an italic), built
from Source Serif 4 and released under the SIL Open Font License 1.1.

The wordmark is not text. It is Neuron converted to outlines and drawn as SVG
(ADR-0048), so it is unaffected by any typeface change and stays as it is.

## Decision

1. **Every piece of text in `apps/mobile` is set in Cahan Serif.** The type
   scale, its sizes and line heights are unchanged, and so is what
   `font-regular` and `font-bold` mean; only the families behind them change.
   `Text` gains an `italic` prop (§ 2).
2. **Four faces ship: Regular (400), Bold (700) and their italics.** Regular
   and Bold are the weights the scale uses. The owner asked for the italics too,
   so text can be set in italic where it is wanted: `<Text italic>` picks the
   italic face of the variant's weight (`font-italic` or `font-bold-italic`).
   The other ten faces stay out of the bundle until a role needs one, which
   would be a token change and not a quiet import.
3. **The files live in the app**, at `apps/mobile/assets/fonts/`, with
   `OFL.txt` beside them. They are loaded by `useFonts` in `app/_layout.tsx`
   under the family names the tokens give (`CahanSerif-Regular`,
   `CahanSerif-Bold`, `CahanSerif-Italic`, `CahanSerif-BoldItalic`), and
   Storybook registers the same files under the same
   names. There is still no CDN request at launch.
4. **`@expo-google-fonts/anybody` leaves `apps/mobile`.** Nothing there imports
   it any more.
5. **The admin panel and the web subscription page keep Anybody.** The owner's
   request was about the app; those are separate surfaces, and their token
   copies are tested against the mobile app's scale, not its family.

## Verification

The shipped files were checked, not assumed, as ADR-0011 did for Anybody: all
four carry `ə Ə ğ Ğ ı İ ö Ö ü Ü ş Ş ç Ç` and `₼` in their `cmap`, and report
weight classes 400 and 700. Their vertical extent (ascent 1036, descent 335 on a
1000-unit em) fits inside the body and caption line heights. The headings'
line heights are tighter than the font's full extent, as they were with
Anybody. The sign-in screen (display heading, caption, field and button) was
checked on an Android emulator: no glyph is clipped, and the wordmark is
unchanged. The italic faces are covered by `Text`'s tests; no screen sets
italic text yet.

## Alternatives considered

- **Ship all 14 faces.** Rejected: about 3.8 MB of TTF for weights no token
  names. The roles that exist, and the italic the owner asked for, need four.
- **Italic through `fontStyle: 'italic'`.** Rejected: on Android a custom
  family with no italic face registered is slanted synthetically, and a
  `font-italic` class layered over `font-bold` would leave two rules competing
  for one `fontFamily`. The `italic` prop chooses one family instead.
- **Map `bold` to SemiBold.** Not taken: nothing asked for it, and the scale
  has always been regular and bold.
- **Change the admin panel and web page too.** Not taken without the owner
  asking. Each would need the font files and its own family token.

## Consequences

- The licence allows bundling the font with the app. It forbids selling the
  font on its own and using "Source" in the family's name, and neither applies.
- A future face (for example a semibold role) means adding its TTF, a token and
  a `useFonts` entry together.
